const assert = require('assert');
const { transaction } = require('objection');
const BigNumber = require('bignumber.js');
const validate = require('celebrate').celebrate;
const { pick } = require('lodash');
const { knex } = require('../database');
const InvestmentFund = require('../models/investment_fund');
const InvestmentFundShares = require('../models/investment_fund_shares');
const InvestmentFundRequest = require('../models/investment_fund_request');
const Balance = require('../models/balance');
const { BadRequest } = require('./errors');
const subscriptionSchema = require('./validation/subscription.schema');
const patchInvestmentFundRequestSchema = require('./validation/admin_update_withdrawal.schema');
const authenticateResource = validate(require('./validation/authenticate_resource.schema'));

class CannotCancelRequest extends BadRequest {
  get code() {
    return 48;
  }

  get message() {
    return 'Investment fund request is not cancelable';
  }
}

class CannotPatchRequest extends BadRequest {
  get code() {
    return 52;
  }

  get message() {
    return 'Investment fund request status is locked';
  }
}

const fetchAll = async (req, res) => {
  const investmentFunds = await InvestmentFund.query()
    .eager('[currency,manager,shares,balanceUpdates,translations]');
  const investmentFundSettings = await knex('investmentFundSettings').select().first();
  return res.status(200).json({ investmentFunds, investmentFundSettings });
};

const subscribeToFund = async (req, res) => {
  const { id } = req.params;
  const { amount } = req.body;
  const userId = req.user.id;

  const investmentFund = await InvestmentFund.query()
    .eager('[shares,currency]')
    .where({ id })
    .first();

  if (!investmentFund) {
    return res.status(404).json({ success: false, message: 'Investment fund not found' });
  }

  const balance = await Balance.query()
    .eager('currency')
    .where({
      userId,
      currencyCode: investmentFund.currencyCode
    }).first();
  assert(balance, 'Balance not found');

  if (req.user.twofa && !req.twofaIsVerified) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const { PENDING } = InvestmentFundRequest.statuses;
  const status =  PENDING;

  let request;
  await transaction(knex, async (trx) => {
    [request] = await Promise.all([
      investmentFund.$relatedQuery('requests', trx).insert({
        userId,
        type: 'subscription',
        amount,
        status,
      }).returning('*'),
      balance.remove(amount, trx),
    ]);
  });

  return res.status(200).json({ success: true, request });
};

const redeemFromFund = async (req, res) => {
  const { id } = req.params;
  const { amount, percent } = req.body;

  assert(amount || percent, 'Need amount or percent for a redemption request');
  const userId = req.user.id;

  const investmentFund = await InvestmentFund.query()
    .eager('[shares,currency]')
    .where({ id })
    .first();

  if (!investmentFund) {
    return res.status(404).json({ success: false, message: 'Investment fund not found' });
  }

  if (req.user.twofa && !req.twofaIsVerified) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  const { PENDING } = InvestmentFundRequest.statuses;
  const status =  PENDING;

  const request = await investmentFund.$relatedQuery('requests').insert({
    userId,
    type: 'redemption',
    amount,
    requestPercent: percent,
    status,
  }).returning('*');

  res.status(200).json({ success: true, request });
};

const cancelRequest = async (req, res) => {
  const { id } = req.params;

  await transaction(knex, async (trx) => {
    const request = await InvestmentFundRequest.query(trx)
      .eager('investmentFund')
      .where({ id, userId: req.user.id })
      .forUpdate()
      .first();

    const { userId } = request;
    if (!request) {
      return res.status(404).json({ success: false, message: 'Investment fund request not found' });
    }

    if (!request.isCancelable) {
      throw new CannotCancelRequest();
    }

    const { currencyCode } = request.investmentFund;
    const balance = await Balance.query(trx)
      .eager('currency')
      .where({ userId, currencyCode })
      .first();

    assert(balance, 'Balance not found');
    const { CANCELED } = InvestmentFundRequest.statuses;
    const refundUser = request.refundable;
    const result = await request.$query(trx).update({
      status: CANCELED,
      refunded: refundUser,
    }).returning('*');

    if (refundUser){
      await balance.add(result.amount, trx);
    }
  });

  return res.status(200).json({ success: true });
};

const patchInvestmentFundRequest = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const investmentFund = await InvestmentFund
    .query()
    .joinRelation('requests')
    .where('requests.id', id)
    .eager('[requests.user.balances.currency,shares,currency,balanceUpdates]')
    .modifyEager('requests', qb => qb.where('id', id))
    .first();

  if (!investmentFund || investmentFund.requests.length === 0) {
    return res.status(404).json({ success: false, message: 'Not found' });
  }

  const [fundRequest] = investmentFund.requests.filter(r => r.id === id);
  if (fundRequest.isLocked) {
    throw new CannotPatchRequest();
  }

  const { APPROVED, DECLINED } = InvestmentFundRequest.statuses;
  if (fundRequest.type === 'subscription' && status === APPROVED) {
    await investmentFund.approveSubscription(fundRequest);
  } else if (fundRequest.type === 'subscription' && status === DECLINED) {
    await investmentFund.declineSubscription(fundRequest);
  } else if (fundRequest.type === 'redemption' && status === APPROVED) {
    await investmentFund.approveRedemption(fundRequest);
  } else if (fundRequest.type === 'redemption' && status === DECLINED) {
    await investmentFund.declineRedemption(fundRequest);
  } else {
    throw new Error('Unknown investment fund request operation');
  }

  return res.status(200).json({ success: true });
};

const activateRequest = async (req, res) => {
  const { authenticationToken } = req.params;
  const { PENDING_EMAIL_VERIFICATION, PENDING } = InvestmentFundRequest.statuses;
  const request = await InvestmentFundRequest.query().where({
    userId: req.user.id,
    authenticationToken,
    status: PENDING_EMAIL_VERIFICATION,
  });

  if (!request) {
    return res.status(404).json({ success: false, message: 'Request not found' });
  }

  await request.$query().update({ status: PENDING });

  return res.status(200).json({ success: true });
};

const fetchRequests = async (req, res) => {
  const { investmentFundId } = req.query;
  const requests = await InvestmentFundRequest.query()
    .joinEager('[investmentFund,fees,profitShares]')
    .where('investmentFundRequests.userId', req.user.id)
    .skipUndefined()
    .where('investmentFundRequests.investmentFundId', investmentFundId)
    .orderBy('createdAt', 'desc');

  return res.status(200).json({ success: true, requests });
};

const fetchAllRequests = async (req, res) => {
  const { investmentFundId } = req.query;
  const requests = await InvestmentFundRequest.query()
    .skipUndefined()
    .where('investmentFundRequests.investmentFundId', investmentFundId)
    .joinEager('[investmentFund,user,fees,profitShares]')
    .orderBy('createdAt', 'desc');

  return res.status(200).json({ success: true, requests });
};

const patchInvestmentFund = async (req, res) => {
  const { id } = req.params;
  const fund = req.body.investmentFund || req.body;
  const args = pick(fund, [
    'name',
    'currencyCode',
    'shortDescription',
    'detailedDescription',
    'riskLevel',
    'redemptionWaitTime',
    'balanceUpdateStrategy',
    'annualPercentageRate',
    'managedBy',
  ]);

  const investmentFund = await InvestmentFund.query()
    .where({ id })
    .first();

  if (!investmentFund) {
    return res.status(404).json({ success: false, message: 'Investment fund not found' });
  }

  const updatedFund = await investmentFund.$query().update(args).returning('*');

  return res.status(200).json({ success: true, investmentFund: updatedFund });
};

const createInvestmentFund = async (req, res) => {
  const fund = req.body.investmentFund || req.body;
  const args = pick(fund, [
    'name',
    'currencyCode',
    'shortDescription',
    'detailedDescription',
    'riskLevel',
    'redemptionWaitTime',
    'balanceUpdateStrategy',
    'annualPercentageRate',
    'managedBy',
  ]);

  const investmentFund = await InvestmentFund.query().insert({
    creatorId: req.user.id,
    ...args,
  }).returning('*');

  return res.status(200).json({ success: true, investmentFund });
};

const fetchShares = async (req, res) => {
  const investmentFundShares = await InvestmentFundShares.query().where('userId', req.user.id);
  return res.status(200).json({ success: true, investmentFundShares });
};

const fetchPerformance = async (req, res) => {
  const userId = req.user.id;
  const funds = await InvestmentFund.query()
    .joinEager('[shares,balanceUpdates]')
    .where('shares.userId', userId)
    .andWhere('shares.amount', '>', 0)
    .orderBy('updatedAt', 'asc');

  const { userRedeemProfitPercent } = await knex('investmentFundSettings').select().first();
  const performance = await Promise.all(funds.map(async (f) => {
    const profitAmount = await f.calculateTotalProfitAmount(userId);
    const userProfitAmount = profitAmount.times(userRedeemProfitPercent);
    const fees = profitAmount.times(1 - userRedeemProfitPercent);
    const investmentValueMinusFees = new BigNumber(f.shares[0].amount).times(f.sharePrice).minus(fees);
    const initialInvestment = investmentValueMinusFees.minus(userProfitAmount);
    const profitPercent = userProfitAmount.dividedBy(initialInvestment)
      .times(100)
      .toFixed(2);
     return {
        investmentFundId: f.id,
        investmentFundName: f.name,
        currencyCode: f.currencyCode,
        shares: f.shares[0].amount,
        profitAmount: userProfitAmount,
        initialInvestment,
        investmentValue: investmentValueMinusFees,
        profitPercent,
    };
  }));

  performance.sort((a, b) => parseFloat(b.profitAmount) - parseFloat(a.profitAmount));

  return res.status(200).json({ success: true, performance });
}

const deleteFund = async (req, res) => {
  const { id } = req.params;
  await InvestmentFund.query().where({ id }).del();
  return res.status(200).json({ success: true });
}

const translateFund = async (req, res) => {
  const { investmentFundId } = req.params;
  const { locale, name, shortDescription, detailedDescription } = req.body;

  const translation = await knex('investment_fund_translations').where({ 
    investmentFundId,
    locale 
  }).first();

  if (!translation) {
    await knex('investment_fund_translations').insert({
      investmentFundId,
      locale,
      name, 
      shortDescription,
      detailedDescription,
    })
  } else {
    await knex('investment_fund_translations').update({
      name,
      shortDescription,
      detailedDescription,
    }).where({ investmentFundId, locale });
  }
  return res.status(200).json({ success: true });
}

const fetchTranslations = async (req, res) => {
  const { investmentFundId } = req.params;

  const translations = await knex('investment_fund_translations').where({ 
    investmentFundId,
  });

  return res.status(200).json({ success: true, translations });
}

module.exports = {
  fetchAll,
  subscribeToFund: [validate(subscriptionSchema), subscribeToFund],
  redeemFromFund,
  fetchShares,
  fetchRequests,
  fetchAllRequests,
  patchInvestmentFundRequest: [validate(patchInvestmentFundRequestSchema), patchInvestmentFundRequest],
  patchInvestmentFund,
  createInvestmentFund,
  cancelRequest,
  activateRequest: [authenticateResource, activateRequest],
  fetchPerformance,
  deleteFund,
  translateFund,
  fetchTranslations,
};
