const { MongoClient } = require('mongodb')
const path = require('path')

require('dotenv').config({ path: path.resolve(__dirname, '../.env') })

try {
  const client = new MongoClient(process.env.MONGO_DB_URL)
  client.connect()
  console.log("Connected to MongoDB")
  const leaderboard_db = client.db('csgo_leaderboards').collection('users')
  
  module.exports = leaderboard_db
}
catch (err){
  console.log("error connecting to mongodb", err)
}
