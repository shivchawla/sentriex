exports.seed = async (knex) => knex('balances').insert([{
  userId: 1,
  currencyCode: 'BTC',
  amount: 0
}, {
  userId: 2,
  currencyCode: 'BTC',
  amount: 0
}, {
  userId: 3,
  currencyCode: 'BTC',
  amount: 10
}]);