const { MongoClient } = require('mongodb')
const path = require('path')

const { TOURNAMENT_ID } = require('../constants')

require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

try {
  const client = new MongoClient(process.env.MONGO_DB_URL)
  client.connect()
  console.log("Connected to MongoDB")
  const db = client.db(`csgo_${TOURNAMENT_ID}_db`).collection('users')

  module.exports = db
}
catch (err){
  console.log("error connecting to mongodb", err)
}
