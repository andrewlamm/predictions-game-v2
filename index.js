const express = require('express')
const app = express()
const passport = require('passport')
const session = require('cookie-session')
const bodyParser = require('body-parser')
const SteamStrategy = require('passport-steam').Strategy
const path = require('path')
const { Impit } = require('impit')

const impit = new Impit({ browser: "chrome" })

const { HLTV } = require('hltv-next')
const myHLTV = HLTV.createInstance({ loadPage:
  async (url) => {
    const response = await impit.fetch(url);
    return response.text()
  }
})

const { TOURNAMENT_ID, TOURNAMENT_NAME } = require('./constants')
const { userDb, completedMatchesDb } = require('./db')

const COMPLETED_MATCHES_DOC = 'completed_matches'

app.set('views', path.join(__dirname, 'views'))
app.set('view engine', 'ejs')
app.use(express.static(`${__dirname}/static`))
app.use(express.urlencoded({ extended: false }))

app.use(bodyParser.urlencoded({ extended: true }))

require('dotenv').config()

/* Steam Authentication */
passport.serializeUser(function(user, done) {
  done(null, user)
})

passport.deserializeUser(function(obj, done) {
  done(null, obj)
})

passport.use(new SteamStrategy({
    returnURL: `${process.env.WEBSITE_LINK}auth/steam/return`,
    realm: process.env.WEBSITE_LINK,
    apiKey: process.env.STEAM_KEY
  },
  function(identifier, profile, done) {
    process.nextTick(function () {
      profile.identifier = identifier
      return done(null, profile)
    })
  }
))

app.use(session({
  secret: process.env.SESSION_SECRET,
  name: 'pog',
  resave: true,
  saveUninitialized: true
}))

app.use(passport.initialize())
app.use(passport.session())

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next()
  res.redirect('/')
}
/* End Steam Authentication */

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const TEAM_TO_ID = {}
const ID_TO_TEAM = {}
const all_matches = {}

let leaderboard = []
const recently_completed = new Set()

const MATCHES_SHOWN = 3
const LEADERBOARD_SHOWN = 5

let startup_complete = false
let repeating = false

function calcScore(prob) {
  return Math.round((25 - (Math.pow(prob - 100, 2) / 100)) * 10) / 10
}

function toOrdinal(i) {
  const j = i % 10
  const k = i % 100;
  if (j == 1 && k != 11) {
    return i + "st"
  }
  if (j == 2 && k != 12) {
    return i + "nd"
  }
  if (j == 3 && k != 13) {
    return i + "rd"
  }
  return i + "th"
}

function findUserInLeaderboard(user) {
  for (let i = 0; i < leaderboard.length; i++) {
    if (leaderboard[i].user === user) {
      return leaderboard[i]
    }
  }
}

/* Start Functions */

async function loadTeams() {
  return new Promise(async function (resolve, reject) {
    let event = undefined;
    try {
      event = await myHLTV.getEvent({id: TOURNAMENT_ID})

      event.teams.forEach((team) => {
        const team_id = team.id
        const team_name = team.name

        TEAM_TO_ID[team_name] = team_id
        ID_TO_TEAM[team_id] = team_name
      })

      resolve(1)
    } catch (err) {
      console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - error loading teams: ${err}, retrying in 10 seconds...`)
      await delay(10000)
      await loadTeams()
      resolve(1)
    }
  })
}

async function loadMatches() {
  return new Promise(async function (resolve, reject) {
    let matches = undefined;
    try {
      matches = await myHLTV.getMatches()

      matches.forEach(match => {
        const eventId = match.event.id
        if (eventId === TOURNAMENT_ID) {
          if (match.team1.id === undefined || match.team2.id === undefined) return // skip matches with a TBD opponent

          const match_id = match.id
          const team1id = match.team1.id
          const team2id = match.team2.id
          const team1 = ID_TO_TEAM[team1id]
          const team2 = ID_TO_TEAM[team2id]
          const startTime = match.live ? new Date() : new Date(match.date)
          const isLive = match.live

          all_matches[match_id] = {
            match_id: match_id,
            team1: team1,
            team2: team2,
            team1id: team1id,
            team2id: team2id,
            startTime: startTime,
            endTime: undefined,
            isLive: isLive,
            isComplete: false,
            team1score: undefined,
            team2score: undefined,
            sumPredictions: 0,
            numPredictions: 0,
          }
        }
      })

      const results = await myHLTV.getResults({eventIds: [TOURNAMENT_ID]})
      results.forEach(result => {
        const match_id = result.id
        const team1 = result.team1.name
        const team2 = result.team2.name
        const team1id = TEAM_TO_ID[team1]
        const team2id = TEAM_TO_ID[team2]
        const startTime = new Date(result.date)
        const team1score = result.result.team1
        const team2score = result.result.team2

        if (result.date + 86400000 > new Date().getTime()) {
          recently_completed.add(match_id)
        }

        all_matches[match_id] = {
          match_id: match_id,
          team1: team1,
          team2: team2,
          team1id: team1id,
          team2id: team2id,
          startTime: startTime,
          endTime: startTime,
          isLive: false,
          isComplete: true,
          team1score: team1score,
          team2score: team2score,
          sumPredictions: 0,
          numPredictions: 0,
        }
      })
      resolve(1)
    } catch (err) {
      console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - error loading matches: ${err}, retrying in 10 seconds...`)
      await delay(10000)
      await loadMatches()
      resolve(1)
    }
  })
}

async function loadDatabases() {
  // function loads all predictions from database
  return new Promise(async function (resolve, reject) {
    await userDb.find().forEach(async function (doc) {
      for (const [key, val] of Object.entries(doc)) {
        if (!isNaN(key)) { // if key is a number, then this is a valid match id
          all_matches[key].numPredictions += 1
          all_matches[key].sumPredictions += val
        }
      }
    })

    const completedMatches = await completedMatchesDb.findOne({ _id: COMPLETED_MATCHES_DOC })
    if (completedMatches === null) {
      await completedMatchesDb.insertOne({ _id: COMPLETED_MATCHES_DOC, matches: [] })
    }
    resolve(1)
  })
}

async function updateLeaderboard() {
  return new Promise(async function (resolve, reject) {
    const oldLeaderboard = []
    const newLeaderboard = []

    await userDb.find().forEach(async function (doc) {
      if (!isNaN(doc._id)) {
        let newPrevDay = 0.0
        recently_completed.forEach(match_id => {
          if (doc[match_id] !== undefined) {
            newPrevDay += all_matches[match_id].team1score > all_matches[match_id].team2score ? calcScore(100 - doc[match_id]) : calcScore(doc[match_id])
          }
        })
        newPrevDay = parseFloat(newPrevDay.toFixed(1))

        oldLeaderboard.push({
          user: doc._id,
          score: parseFloat((doc.score - newPrevDay).toFixed(1)),
        })
        newLeaderboard.push({
          user: doc._id,
          username: doc.displayName,
          steamURL: doc.steamURL,
          score: doc.score,
          correct: doc.correct,
          totalGuesses: doc.correct + doc.incorrect,
          prevDay: newPrevDay,
          spotsChanged: 0,
        })
      }
    })

    oldLeaderboard.sort((a, b) => {
      return b.score - a.score || b.correct - a.correct
    })
    newLeaderboard.sort((a, b) => {
      return b.score - a.score || b.correct - a.correct
    })

    const user_to_rank = {}
    for (let i = 0; i < oldLeaderboard.length; i++) {
      if (i == 0) {
        user_to_rank[oldLeaderboard[i].user] = i
      }
      else {
        if (oldLeaderboard[i].score === oldLeaderboard[i - 1].score && oldLeaderboard[i].correct === oldLeaderboard[i - 1].correct) {
          // same score as the person before, so use their rank as well
          user_to_rank[oldLeaderboard[i].user] = user_to_rank[oldLeaderboard[i - 1].user]
        }
        else {
          user_to_rank[oldLeaderboard[i].user] = i
        }
      }
    }

    for (let i = 0; i < newLeaderboard.length; i++) {
      let place = i
      if (i !== 0) {
        if (newLeaderboard[i].score === newLeaderboard[i - 1].score && newLeaderboard[i].correct === newLeaderboard[i - 1].correct) {
          place = newLeaderboard[i - 1].place
        }
      }

      newLeaderboard[i].spotsChanged = user_to_rank[newLeaderboard[i].user] - place
      newLeaderboard[i].place = place
    }
    leaderboard = newLeaderboard

    resolve(1)
  })
}

async function newCompletedMatch(match_id) {
  // function is called when a new match is completed
  // update user scores in the database
  return new Promise(async function (resolve, reject) {
    try {
      const team1win = all_matches[match_id].team1score > all_matches[match_id].team2score
      await userDb.find().forEach(async function (doc) {
        if (!isNaN(doc._id)) {
          const query = { _id: doc._id }

          const update = { $set: {} }

          if (doc[match_id] !== undefined) {
            // user predicted on this match
            const userGuess = parseInt(doc[match_id])
            if (team1win) {
              update.$set.score = parseFloat((calcScore(100 - userGuess) + doc.score).toFixed(1))
              if (userGuess > 50) {
                // user guessed incorrectly
                update.$set.incorrect = doc.incorrect + 1
              }
              else if (userGuess < 50) {
                // user guessed correctly
                update.$set.correct = doc.correct + 1
              }
            }
            else {
              update.$set.score = parseFloat((calcScore(userGuess) + doc.score).toFixed(1))
              if (userGuess > 50) {
                // user guessed correctly
                update.$set.correct = doc.correct + 1
              }
              else if (userGuess < 50) {
                // user guessed incorrectly
                update.$set.incorrect = doc.incorrect + 1
              }
            }

            const updateRes = await userDb.updateOne(query, update)
          }
        }
      })

      const completedMatchesDoc = await completedMatchesDb.findOne({ _id: COMPLETED_MATCHES_DOC })
      if (!completedMatchesDoc.matches.includes(match_id)) {
        completedMatchesDoc.matches.push(match_id)
        await completedMatchesDb.updateOne({ _id: COMPLETED_MATCHES_DOC }, { $set: { matches: completedMatchesDoc.matches } })
      }

      // update leaderboard
      await delay(1000) // slight delay to help mongodb problems
      await updateLeaderboard()

      resolve(1)
    }
    catch (err) {
      console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - error updating user scores: ${err}, match: ${match_id}`)

      resolve(1)
    }
  })
}

async function setupCompletedMatchesOnStartup() {
  return new Promise(async function (resolve, reject) {
    const completedMatchesDoc = await completedMatchesDb.findOne({ _id: COMPLETED_MATCHES_DOC })
    const completedMatchesSaved = completedMatchesDoc.matches

    for (const match_id in all_matches) {
      if (all_matches[match_id].isComplete && !completedMatchesSaved.includes(match_id)) {
        console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - found uncalculated completed match in startup: ${match_id}`)
        await newCompletedMatch(match_id)
      }
    }

    resolve(1)
  })
}

async function checkMatches() {
  // function that loads all matches to check for new matches (repeats from timer)
  let matches = undefined;
  try {
    matches = await myHLTV.getMatches()

    matches.forEach(match => {
      const eventId = match.event.id
      if (eventId === TOURNAMENT_ID) {
        const match_id = match.id
        if (match.live) {
          if (all_matches[match_id] === undefined) {
            console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - new untracked live match: ${match_id}`)

            const team1id = match.team1.id
            const team2id = match.team2.id
            const team1 = ID_TO_TEAM[team1id]
            const team2 = ID_TO_TEAM[team2id]

            all_matches[match_id] = {
              match_id: match_id,
              team1: team1,
              team2: team2,
              team1id: team1id,
              team2id: team2id,
              team1score: undefined,
              team2score: undefined,
              startTime: new Date(),
              endTime: undefined,
              isLive: true,
              isComplete: false,
              sumPredictions: 0,
              numPredictions: 0,
            }
          }
          else if (!all_matches[match_id].isLive && !all_matches[match_id].isComplete) {
            console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - now match live: ${match_id}`)
            all_matches[match_id].isLive = true
            all_matches[match_id].startTime = new Date() < all_matches[match_id].startTime ? new Date() : all_matches[match_id].startTime
          }
        }
        else {
          if (all_matches[match_id] === undefined) {
            if (match.team1.id === undefined || match.team2.id === undefined) return // skip matches with a TBD opponent

            console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - new upcoming match: ${match_id}`)
            const team1id = match.team1.id
            const team2id = match.team2.id
            const team1 = ID_TO_TEAM[team1id]
            const team2 = ID_TO_TEAM[team2id]
            const startTime = new Date(match.date)

            all_matches[match_id] = {
              match_id: match_id,
              team1: team1,
              team2: team2,
              team1id: team1id,
              team2id: team2id,
              team1score: undefined,
              team2score: undefined,
              startTime: startTime,
              endTime: undefined,
              isLive: false,
              isComplete: false,
              sumPredictions: 0,
              numPredictions: 0,
            }
          }
          else {
            const startTime = new Date(match.date)
            all_matches[match_id].startTime = startTime

            if (all_matches[match_id].isLive) {
              console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - match unlive: ${match_id}`)
              all_matches[match_id].isLive = false
            }
          }
        }
      }
    })

    const results = await myHLTV.getResults({eventIds: [TOURNAMENT_ID]})
    results.forEach(async result => {
      const match_id = result.id
      if (all_matches[match_id] === undefined) {
        console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - new completed match: ${match_id}`)

        const team1 = result.team1.name
        const team2 = result.team2.name
        const team1id = TEAM_TO_ID[team1]
        const team2id = TEAM_TO_ID[team2]
        const team1score = result.result.team1
        const team2score = result.result.team2

        const resultDate = new Date(result.date)
        const endTime = new Date() < resultDate ? new Date() : resultDate

        all_matches[match_id] = {
          match_id: match_id,
          team1: team1,
          team2: team2,
          team1id: team1id,
          team2id: team2id,
          team1score: team1score,
          team2score: team2score,
          startTime: endTime,
          endTime: endTime,
          isLive: false,
          isComplete: true,
          sumPredictions: 0,
          numPredictions: 0,
        }
      }
      else if (!all_matches[match_id].isComplete) {
        console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - match complete: ${match_id}`)

        const team1score = result.result.team1
        const team2score = result.result.team2

        const resultDate = new Date(result.date)

        all_matches[match_id].isLive = false
        all_matches[match_id].isComplete = true
        all_matches[match_id].endTime = new Date() < resultDate ? new Date() : resultDate
        all_matches[match_id].team1score = team1score
        all_matches[match_id].team2score = team2score

        recently_completed.add(match_id)
        await newCompletedMatch(match_id)
      }
    })
  } catch (err) {
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - error loading matches (in repeat): ${err}, retrying in 60 seconds...`)
  }
}

async function updateRecentlyCompleted() {
  // update recently completed set
  return new Promise(async function (resolve, reject) {
    const curr_time = new Date()
    let updated = false
    recently_completed.forEach(match_id => {
      if (all_matches[match_id].endTime.getTime() + 86400000 < curr_time.getTime()) {
        recently_completed.delete(match_id)
        updated = true
      }
    })

    if (updated) {
      // need to update leaderboard with new 24 hr updates
      await updateLeaderboard()
    }
    resolve(1)
  })
}

async function repeatedFunctions() {
  return new Promise(async function (resolve, reject) {
    // console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - repeating...`)
    if (repeating) {
      // console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - skipped`)

      resolve(1)
    }
    else {
      repeating = true
      await checkMatches()
      await updateRecentlyCompleted()
      // console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - repeat complete`)

      repeating = false
      resolve(1)
    }
  })
}

async function start() {
  try {
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - loading teams...`)
    await loadTeams()
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - loading matches...`)
    await loadMatches()
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - loading databases...`)
    await loadDatabases()
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - loading leaderboard...`)
    await updateLeaderboard()
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - updating completed matches if necessary...`)
    await setupCompletedMatchesOnStartup()

    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - startup complete`)
    startup_complete = true

    const repeatTimer = setInterval(repeatedFunctions, 60000)
  }
  catch (err) {
    console.log('error on startup')
    console.log(err)
  }
}

start()

/* EJS Helper Functions */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Nov', 'Dec']

app.locals.getDate = function(time) {
  const timeString = time.toLocaleString("en-US", { timeZone: "America/New_York" })
  const dates = timeString.substring(0, timeString.indexOf(',')).split('/')

  return `${MONTHS[parseInt(dates[0]) - 1]} ${dates[1]} ${dates[2]}`
}

app.locals.getTime = function(time) {
  const timeString = time.toLocaleString("en-US", { timeZone: "America/New_York" })
  const times = timeString.substring(timeString.indexOf(',') + 2, timeString.indexOf(' ', timeString.indexOf(',') + 2)).split(':')

  return `${times[0]}:${times[1]} ${timeString.substring(timeString.indexOf(' ', timeString.indexOf(',') + 2)+1)} (EST)`
}

app.locals.setTimer = function(diff) {
  if (diff <= 0) return 'SOON'
  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)
  const seconds = Math.floor((diff % 60000) / 1000)

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`
  }
  else {
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
    else if (minutes > 0) return `${minutes}m ${seconds}s`
    else return `${seconds}s`
  }
}

app.locals.calcScore = function(prob) {
  return calcScore(prob)
}

/* Middleware */

function getUpcomingMatches(req, res, next) {
  if (!startup_complete) next()
  else {
    res.locals.upcoming_matches = []

    for (const match_id in all_matches) {
      if (!all_matches[match_id].isComplete && !all_matches[match_id].isLive) {
        res.locals.upcoming_matches.push({...all_matches[match_id], userGuess: res.locals.userDoc[match_id], averageGuess: all_matches[match_id].numPredictions === 0 ? 50 : Math.round(all_matches[match_id].sumPredictions / all_matches[match_id].numPredictions)})
      }
    }

    res.locals.upcoming_matches.sort((a, b) => {
      return a.startTime - b.startTime
    })

    next()
  }
}

async function checkDocumentExists(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined) {
      // user is not logged in
      res.locals.userDoc = {}
      next()
    }
    else {
      const query = { _id: req.user._json.steamid }
      const result = await userDb.findOne(query)

      res.locals.userDoc = result

      if (result === null) {
        // new user, insert new doc into database
        const newDoc = {
          _id: req.user._json.steamid,
          displayName: req.user._json.personaname,
          steamURL: req.user._json.profileurl,
          avatar: req.user.photos[2].value,
          score: 0.0,
          correct: 0,
          incorrect: 0,
        }

        const insRes = await userDb.insertOne(newDoc)
        res.locals.userDoc = newDoc
        req.user.points = 0.0

        console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - new user: ${insRes.insertedId}`)

        // update leaderboard with new user
        leaderboard.push({
          user: req.user._json.steamid,
          username: req.user._json.personaname,
          steamURL: req.user._json.profileurl,
          score: 0.0,
          place: leaderboard.length,
          correct: 0,
          totalGuesses: 0,
          prevDay: 0.0,
          spotsChanged: 0,
        })

        await delay(1000) // slight delay to help mongodb problems
        await updateLeaderboard()

        next()
      }
      else {
        // old user, update user if necessary
        req.user.points = result.score

        if (result.displayName !== req.user._json.personaname || result.steamURL !== req.user._json.profileurl || result.avatar !== req.user.photos[2].value) {
          const query = { _id: req.user._json.steamid }
          const update = {
            $set: {
              displayName: req.user._json.personaname,
              steamURL: req.user._json.profileurl,
              avatar: req.user.photos[2].value
            }
          }

          const updateRes = await userDb.updateOne(query, update)

          next()
        }
        else {
          // believe this is necessary with the await
          next()
        }
      }
    }
  }
}

function getCompletedMatches(req, res, next) {
  if (!startup_complete) next()
  else {
    res.locals.completed_matches = []

    for (const match_id in all_matches) {
      if (all_matches[match_id].isLive || all_matches[match_id].isComplete) {
        res.locals.completed_matches.push({...all_matches[match_id], userGuess: res.locals.userDoc[match_id], averageGuess: all_matches[match_id].numPredictions === 0 ? undefined : Math.round(all_matches[match_id].sumPredictions / all_matches[match_id].numPredictions)})
      }
    }

    res.locals.completed_matches.sort((a, b) => {
      if (a.isLive && b.isLive) return a.startTime - b.startTime
      else if (a.isLive) return -1
      else if (b.isLive) return 1
      return b.endTime - a.endTime
    })

    next()
  }
}

function getLiveMatches(req, res, next) {
  if (!startup_complete) next()
  else {
    res.locals.live_matches = []

    for (const match_id in all_matches) {
      if (all_matches[match_id].isLive) {
        res.locals.live_matches.push({...all_matches[match_id], userGuess: res.locals.userDoc[match_id], averageGuess: all_matches[match_id].numPredictions === 0 ? undefined : Math.round(all_matches[match_id].sumPredictions / all_matches[match_id].numPredictions)})
      }
    }

    res.locals.live_matches.sort((a, b) => {
      return a.startTime - b.startTime
    })

    next()
  }
}

async function insertGuessHelper(req, res, next) {
  if (!startup_complete) {
    next()
  }
  else if (req.user === undefined || req.user._json === undefined) {
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - insert guess fail, not logged in`)
    next()
  }
  else if (req.body.match_id === undefined || all_matches[req.body.match_id] === undefined) {
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - insert guess fail, invalid match id: ${req.body.match_id}, user: ${req.user._json.steamid}`)
    next()
  }
  else if (isNaN(req.body.prob) || parseInt(req.body.prob) < 0 || parseInt(req.body.prob) > 100) {
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - insert guess fail, invalid probability: ${req.body.prob}, user: ${req.user._json.steamid}`)
    next()
  }
  else if (all_matches[req.body.match_id].isComplete || all_matches[req.body.match_id].isLive) {
    console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - insert guess fail, match is complete or live: ${req.body.match_id}, user: ${req.user._json.steamid}`)
    next()
  }
  else {
    try {
      const query = { _id: req.user._json.steamid }
      const results = await userDb.findOne(query)

      if (results[req.body.match_id] !== undefined) {
        // user has guessed on this match before
        all_matches[req.body.match_id].sumPredictions -= results[req.body.match_id]
      }
      else {
        // new guess for user
        all_matches[req.body.match_id].numPredictions += 1
      }

      all_matches[req.body.match_id].sumPredictions += parseInt(req.body.prob)

      const update = { $set: {} }
      update.$set[req.body.match_id] = parseInt(req.body.prob)

      const updateRes = await userDb.updateOne(query, update)

      next()
    }
    catch (err) {
      console.log(`${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} - insert guess fail, error: ${err}, user: ${req.user._json.steamid}`)
      next()
    }
  }
}

function findUserPlace(req, res, next) {
  if (!startup_complete) next()
  else if (!req.user) next()
  else {
    for (let i = 0; i < leaderboard.length; i++) {
      if (leaderboard[i].user === req.user._json.steamid) {
        res.locals.userPlace = leaderboard[i].place + 1
        res.locals.userPoints = leaderboard[i].score
        break
      }
    }

    next()
  }
}

async function getUserInfo(req, res, next) {
  if (!startup_complete) next()
  else {
    const query = { _id: req.params.userID }
    const results = await userDb.findOne(query)

    if (results === null) {
      // user does not exist
      res.locals.userInfo = undefined
      next()
    }
    else {
      const userInfo = findUserInLeaderboard(req.params.userID)
      res.locals.userInfo = {
        displayName: results.displayName,
        steamURL: results.steamURL,
        avatar: results.avatar,
        place: toOrdinal(userInfo.place + 1),
        score: userInfo.score,
        correct: userInfo.correct,
        totalGuesses: userInfo.totalGuesses,
        prevDay: userInfo.prevDay,
        spotsChanged: userInfo.spotsChanged,
        userMatches: []
      }

      if (req.user && req.user._json.steamid === req.params.userID) {
        // user looking at their own profile
        for (const match_id in all_matches) {
          res.locals.userInfo.userMatches.push({ ...all_matches[match_id], userGuess: results[match_id] })
        }
      }
      else {
        // user looking at someone else's profile
        for (const match_id in all_matches) {
          if (all_matches[match_id].isComplete || all_matches[match_id].isLive) {
            res.locals.userInfo.userMatches.push({ ...all_matches[match_id], userGuess: results[match_id] })
          }
        }
      }

      res.locals.userInfo.userMatches.sort((a, b) => {
        if (!a.isComplete && !b.isComplete) return a.startTime - b.startTime
        else if (!a.isComplete) return -1
        else if (!b.isComplete) return 1
        return b.endTime - a.endTime
      })

      next()
    }
  }
}

/* Routes */

app.get('/', [checkDocumentExists, getLiveMatches, getUpcomingMatches, getCompletedMatches], (req, res) => {
  if (!startup_complete) {
    res.render('loading')
  }
  else {
    req.session.currLink = '/'
    const upcomingMatches = res.locals.live_matches.concat(res.locals.upcoming_matches).slice(0, MATCHES_SHOWN)
    const completedMatches = res.locals.completed_matches.filter(match => match.isComplete).slice(0, MATCHES_SHOWN)
    const leaderboardDisplay = leaderboard.slice(0, LEADERBOARD_SHOWN)

    res.render('index', { user: req.user, upcomingMatches: upcomingMatches, completedMatches: completedMatches, leaderboard: leaderboardDisplay, tournamentName: TOURNAMENT_NAME })
  }
})

app.get('/upcomingMatches', [checkDocumentExists, getUpcomingMatches, findUserPlace], (req, res) => {
  if (!startup_complete) {
    res.render('loading')
  }
  else {
    req.session.currLink = '/upcomingMatches'
    res.render('upcoming-matches', { user: req.user, matches: res.locals.upcoming_matches, userPoints: res.locals.userPoints, userPlace: toOrdinal(res.locals.userPlace), totalUsers: leaderboard.length })
  }
})

app.post('/insertGuess', [insertGuessHelper], (req, res) => {
  res.send()
})

app.get('/completedMatches', [checkDocumentExists, getCompletedMatches], (req, res) => {
  if (!startup_complete) {
    res.render('loading')
  }
  else {
    req.session.currLink = '/completedMatches'
    res.render('completed-matches', { user: req.user, matches: res.locals.completed_matches })
  }
})

app.get('/leaderboard', [checkDocumentExists], (req, res) => {
  if (!startup_complete) {
    res.render('loading')
  }
  else {
    req.session.currLink = '/leaderboard'
    res.render('leaderboard', { user: req.user, leaderboard: leaderboard })
  }
})

app.get('/user/:userID', [checkDocumentExists, getUserInfo], (req, res) => {
  if (!startup_complete) {
    res.render('loading')
  }
  else {
    req.session.currLink = `/user/${req.params.userID}`
    res.render('user-profile', { user: req.user, userInfo: res.locals.userInfo, totalUsers: leaderboard.length })
  }
})

/* Steam Authentication Links */

app.get('/logout', function(req, res) {
  req.logout()
  res.redirect('/')
})

app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }), function(req, res) {
  res.redirect(req.session.currLink || '/')
})

app.get('/auth/steam/return', passport.authenticate('steam', { failureRedirect: '/' }), function(req, res) {
  res.redirect(req.session.currLink || '/')
})

/* Testing Routes */

app.get('/test', async (req, res) => {
  if (req.user !== undefined && (req.user._json.steamid === "76561199063897236" || req.user._json.steamid === "76561198251387562")) {
    res.send(all_matches)
  }
  else {
    res.render('404')
  }
})

app.get('/leaderboardtest', async (req, res) => {
  if (req.user !== undefined && (req.user._json.steamid === "76561199063897236" || req.user._json.steamid === "76561198251387562")) {
    res.send(leaderboard)
  }
  else {
    res.render('404')
  }
})

/* 404 Page */
app.use(function(req, res, next) {
  res.render('404')
})

app.listen(process.env.PORT || 3000, () => console.log("Server is running..."))

// npx tailwindcss -i ./static/styles.css -o ./static/output.css --watch
