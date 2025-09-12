const { MongoClient } = require('mongodb')
const path = require('path')

const { TOURNAMENT_ID } = require('../constants')

require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

try {
  const client = new MongoClient(process.env.MONGO_DB_URL)
  client.connect()
  console.log("Connected to MongoDB")
  const db = client.db(`csgo_${TOURNAMENT_ID}_db`)
  const userDb = db.collection('users')
  const completedMatchesDb = db.collection('completed_matches')

  module.exports = { userDb, completedMatchesDb }
}
catch (err){
  console.log("error connecting to mongodb", err)
}
