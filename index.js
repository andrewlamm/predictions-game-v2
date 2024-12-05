const express = require('express')
const app = express()
const passport = require('passport')
const session = require('cookie-session')
const JSSoup = require('jssoup').default
const bodyParser = require('body-parser')
const SteamStrategy = require('passport-steam').Strategy
const { gotScraping, create } = require('got-scraping')
const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
const { uuid } = require('uuidv4')

const db = require('./db')
const leaderboard_db = require('./leaderboards')

puppeteer.use(StealthPlugin())

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

async function getParsedPage(url) {
  return new Promise(async function (resolve, reject) {
    await delay(1000)

    try {
      const browser = await puppeteer.launch({ 
        headless: true, 
        args: [
          '--autoplay-policy=user-gesture-required',
          '--disable-background-networking',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-breakpad',
          '--disable-client-side-phishing-detection',
          '--disable-component-update',
          '--disable-default-apps',
          '--disable-dev-shm-usage',
          '--disable-domain-reliability',
          '--disable-extensions',
          '--disable-features=AudioServiceOutOfProcess',
          '--disable-hang-monitor',
          '--disable-ipc-flooding-protection',
          '--disable-notifications',
          '--disable-offer-store-unmasked-wallet-cards',
          '--disable-popup-blocking',
          '--disable-print-preview',
          '--disable-prompt-on-repost',
          '--disable-renderer-backgrounding',
          '--disable-setuid-sandbox',
          '--disable-speech-api',
          '--disable-sync',
          '--hide-scrollbars',
          '--ignore-gpu-blacklist',
          '--metrics-recording-only',
          '--mute-audio',
          '--no-default-browser-check',
          '--no-first-run',
          '--no-pings',
          '--no-sandbox',
          '--no-zygote',
          '--password-store=basic',
          '--use-gl=swiftshader',
          '--use-mock-keychain',
        ]
      })
      const browserPage = await browser.newPage()

      await browserPage.setRequestInterception(true)

      browserPage.on('request', async request => {
        if (request.resourceType() === 'fetch' || request.resourceType() === 'image' || request.resourceType() === 'media' || request.resourceType() === 'font' || request.resourceType() === 'stylesheet' || request.resourceType() === 'websocket' || request.resourceType() === 'manifest' || request.resourceType() === 'other' || 
            (request.resourceType() === 'script' && !request.url().includes('hltv.js'))) {
          request.abort()
        } else {
          // console.log(request.url())
          request.continue()
        }
      })

      await browserPage.setDefaultNavigationTimeout(60000) // 1 minute
      await browserPage.goto(url, { waitUntil: 'networkidle0' })
      
      const fullPage = await browserPage.evaluate(() => document.body.innerHTML)

      browser.close()
      
      const page = '<html><body>' + fullPage.substring(fullPage.indexOf('<div class="navbar">')) // reduce page size to only relevant content
      // return new JSSoup(page)
      resolve(new JSSoup(page))
    }
    catch (err) {
      console.log(err)
      // const page = await (await gotScraping.get(url)).body
      console.log('repeating parse')
      const page = await getParsedPage(url)

      // return new JSSoup(page)
      resolve(page)
    }
  })
}

/* Tournament Links */
const TOURNAMENT_URL = 'https://www.hltv.org/events/6973/blast-premier-fall-groups-2023'
const MATCHES_URL = 'https://www.hltv.org/events/6973/matches'
const RESULTS_URL = 'https://www.hltv.org/results?event=6973'
const TOURNAMENT_NAME = 'BLAST Premier Fall Groups 2023'

const TEAM_TO_LOGO = require('./logos')
const TEAM_TO_ID = {}
const ID_TO_TEAM = {}
const all_matches = {}

let leaderboard = []
const recently_completed = new Set()
let all_user_data = {}

const MATCHES_SHOWN = 3
const LEADERBOARD_SHOWN = 5

const MAX_LEADERBOARDS = 3

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
    const web_data = await getParsedPage(TOURNAMENT_URL)
    const all_teams = web_data.findAll('div', {'class': 'team-box'} )

    for (let i = 0; i < all_teams.length; i++) {
      const team_name = all_teams[i].find('div', {'class': 'team-name'} ).find('div', {'class': 'text'} ).text

      TEAM_TO_ID[team_name] = i
      ID_TO_TEAM[i] = team_name
    }

    resolve(1)
  })
}

async function loadMatches() {
  return new Promise(async function (resolve, reject) {
    const match_data = await getParsedPage(MATCHES_URL)
    const results_data = await getParsedPage(RESULTS_URL)

    const live_matches = match_data.findAll('div', {'class': 'liveMatch'} )
    const upcoming_matches = match_data.findAll('div', {'class': 'upcomingMatch'} )
    const completed_matches = results_data.findAll('div', {'class': 'result-con'} )

    for (let i = 0; i < live_matches.length; i++) {
      const match_id = parseInt(live_matches[i].attrs['data-livescore-match'])

      const teams = live_matches[i].findAll('div', {'class': 'matchTeamName'} )
      const team1 = teams[0].text
      const team2 = teams[1].text

      const scores = live_matches[i].findAll('div', {'class': 'matchTeamScore'} )
      const team1score = scores[0].text.substring(1)
      const team2score = scores[1].text.substring(1)
      
      all_matches[match_id] = {
        match_id: match_id,
        team1: team1,
        team2: team2,
        team1score: team1score,
        team2score: team2score,
        startTime: new Date(),
        endTime: undefined,
        isLive: true,
        isComplete: false,
        sumPredictions: 0,
        numPredictions: 0,
      }
    }

    for (let i = 0; i < upcoming_matches.length; i++) {
      const match_id = parseInt(upcoming_matches[i].find('a').attrs['href'].split('/')[2])

      if (upcoming_matches[i].find('div', {'class': 'matchInfoEmpty'} ) === undefined) {
        const teams = upcoming_matches[i].findAll('div', {'class': 'matchTeamName'} )
        if (teams.length != 2) continue // skip matches with a TBD opponent
        const team1 = teams[0].text
        const team2 = teams[1].text

        const match_time = parseInt(upcoming_matches[i].find('div', {'class': 'matchTime'} ).attrs['data-unix'])

        all_matches[match_id] = {
          match_id: match_id,
          team1: team1,
          team2: team2,
          team1score: 0,
          team2score: 0,
          startTime: new Date(match_time),
          endTime: undefined,
          isLive: false,
          isComplete: false,
          sumPredictions: 0,
          numPredictions: 0,
        }
      }
    }

    for (let i = 0; i < completed_matches.length; i++) {
      const match_id = parseInt(completed_matches[i].find('a').attrs['href'].split('/')[2])

      const team1 = completed_matches[i].find('div', {'class': 'team1'} ).text
      const team2 = completed_matches[i].find('div', {'class': 'team2'} ).text

      const scores = completed_matches[i].find('td', {'class': 'result-score'} ).findAll('span')
      const team1score = parseInt(scores[0].text)
      const team2score = parseInt(scores[1].text)

      const end_time = parseInt(completed_matches[i].attrs['data-zonedgrouping-entry-unix'])

      if (end_time + 86400000 > new Date().getTime()) {
        recently_completed.add(match_id)
      }

      all_matches[match_id] = {
        match_id: match_id,
        team1: team1,
        team2: team2,
        team1score: team1score,
        team2score: team2score,
        startTime: new Date(end_time),
        endTime: new Date(end_time),
        isLive: false,
        isComplete: true,
        sumPredictions: 0,
        numPredictions: 0,
      }
    }
    
    resolve(1)
  })
}

async function loadDatabases() {
  // function loads all predictions from database
  return new Promise(async function (resolve, reject) {
    await db.find().forEach(async function (doc) {
      for (const [key, val] of Object.entries(doc)) {
        if (!isNaN(key)) { // if key is a number, then this is a valid match id
          all_matches[key].numPredictions += 1
          all_matches[key].sumPredictions += val
        }
      }
    })
    resolve(1)
  })
}

async function updateGlobalLeaderboard() {
  return new Promise(async function (resolve, reject) {
    const oldLeaderboard = []
    const newLeaderboard = []
    all_user_data = {}

    await db.find().forEach(async function (doc) {
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

        all_user_data[doc._id] = {
          user: doc._id,
          username: doc.displayName,
          steamURL: doc.steamURL,
          score: doc.score,
          correct: doc.correct,
          totalGuesses: doc.correct + doc.incorrect,
          prevDay: newPrevDay,
          spotsChanged: 0,
        }
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
      await db.find().forEach(async function (doc) {
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

            const updateRes = await db.updateOne(query, update)
          }
        }
      })

      // update leaderboard
      await delay(1000) // slight delay to help mongodb problems
      await updateGlobalLeaderboard()

      resolve(1)
    }
    catch (err) {
      console.log(`error updating user scores: ${err}, match: ${match_id}`)
    }
  })
}

async function checkMatches() {
  // function that loads all matches to check for new matches (repeats from timer)
  const match_data = await getParsedPage(MATCHES_URL)
  const results_data = await getParsedPage(RESULTS_URL)

  const live_matches = match_data.findAll('div', {'class': 'liveMatch'} )
  const upcoming_matches = match_data.findAll('div', {'class': 'upcomingMatch'} )
  const completed_matches = results_data.findAll('div', {'class': 'result-con'} )

  for (let i = 0; i < live_matches.length; i++) {
    const match_id = parseInt(live_matches[i].attrs['data-livescore-match'])

    if (all_matches[match_id] === undefined) {
      console.log(`new untracked live match: ${match_id}`)
      const teams = live_matches[i].findAll('div', {'class': 'matchTeamName'} )
      const team1 = teams[0].text
      const team2 = teams[1].text

      all_matches[match_id] = {
        match_id: match_id,
        team1: team1,
        team2: team2,
        team1score: 0,
        team2score: 0,
        startTime: new Date(),
        endTime: undefined,
        isLive: true,
        isComplete: false,
        sumPredictions: 0,
        numPredictions: 0,
      }
    }
    else if (!all_matches[match_id].isLive) {
      console.log(`now match live: ${match_id}`)
      all_matches[match_id].isLive = true
      all_matches[match_id].startTime = new Date() < all_matches[match_id].startTime ? new Date() : all_matches[match_id].startTime
    }

    const scores = live_matches[i].findAll('div', {'class': 'matchTeamScore'} )
    const team1score = scores[0].text.substring(1)
    const team2score = scores[1].text.substring(1)

    all_matches[match_id].team1score = team1score
    all_matches[match_id].team2score = team2score
  }

  for (let i = 0; i < upcoming_matches.length; i++) {
    const match_id = parseInt(upcoming_matches[i].find('a').attrs['href'].split('/')[2])

    if (all_matches[match_id] === undefined) {
      if (upcoming_matches[i].find('div', {'class': 'matchInfoEmpty'} ) === undefined) {
        const teams = upcoming_matches[i].findAll('div', {'class': 'matchTeamName'} )
        if (teams.length != 2) continue // skip matches with a TBD opponent
        console.log(`new upcoming match: ${match_id}`)
        const team1 = teams[0].text
        const team2 = teams[1].text

        const match_time = parseInt(upcoming_matches[i].find('div', {'class': 'matchTime'} ).attrs['data-unix'])

        all_matches[match_id] = {
          match_id: match_id,
          team1: team1,
          team2: team2,
          team1score: 0,
          team2score: 0,
          startTime: new Date(match_time),
          endTime: undefined,
          isLive: false,
          isComplete: false,
          sumPredictions: 0,
          numPredictions: 0,
        }
      }
    }
    else {
      const match_time = parseInt(upcoming_matches[i].find('div', {'class': 'matchTime'} ).attrs['data-unix'])
      all_matches[match_id].startTime = new Date(match_time)

      if (all_matches[match_id].isLive) {
        console.log(`match unlive: ${match_id}`)
        all_matches[match_id].isLive = false
      }
    }
  }

  for (let i = 0; i < completed_matches.length; i++) {
    const match_id = parseInt(completed_matches[i].find('a').attrs['href'].split('/')[2])

    if (all_matches[match_id] === undefined) {
      console.log(`untracked match complete: ${match_id}`)

      const team1 = completed_matches[i].find('div', {'class': 'team1'} ).text
      const team2 = completed_matches[i].find('div', {'class': 'team2'} ).text

      const scores = completed_matches[i].find('td', {'class': 'result-score'} ).findAll('span')
      const team1score = parseInt(scores[0].text)
      const team2score = parseInt(scores[1].text)

      const end_time = parseInt(completed_matches[i].attrs['data-zonedgrouping-entry-unix'])

      all_matches[match_id] = {
        match_id: match_id,
        team1: team1,
        team2: team2,
        team1score: team1score,
        team2score: team2score,
        startTime: new Date() < new Date(end_time) ? new Date() : new Date(end_time),
        endTime: new Date() < new Date(end_time) ? new Date() : new Date(end_time),
        isLive: false,
        isComplete: true,
        sumPredictions: 0,
        numPredictions: 0,
      }
    }
    else if (!all_matches[match_id].isComplete) { 
      console.log(`match complete: ${match_id}`)

      const scores = completed_matches[i].find('td', {'class': 'result-score'} ).findAll('span')
      const team1score = parseInt(scores[0].text)
      const team2score = parseInt(scores[1].text)

      const end_time = parseInt(completed_matches[i].attrs['data-zonedgrouping-entry-unix'])

      all_matches[match_id].isLive = false
      all_matches[match_id].isComplete = true
      all_matches[match_id].endTime = new Date() < new Date(end_time) ? new Date() : new Date(end_time)
      all_matches[match_id].team1score = team1score
      all_matches[match_id].team2score = team2score

      recently_completed.add(match_id)
      await newCompletedMatch(match_id)
    }
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
      await updateGlobalLeaderboard()
    }
    resolve(1)
  })
}

async function repeatedFunctions() {
  return new Promise(async function (resolve, reject) {
    console.log("repeat - ", new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))
    if (repeating) {
      console.log("skipped")

      resolve(1)
    }
    else {
      repeating = true
      await checkMatches()
      await updateRecentlyCompleted()
      console.log("repeat complete - ", new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))

      repeating = false
      resolve(1)
    }
  })
}

async function start() {
  try {
    console.log('loading teams...')
    await loadTeams()
    console.log('loading matches...')
    await loadMatches()
    console.log('loading databases...')
    await loadDatabases()
    console.log('loading leaderboard...')
    await updateGlobalLeaderboard()

    console.log('startup complete')
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
      const result = await db.findOne(query)

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

        const insRes = await db.insertOne(newDoc)
        res.locals.userDoc = newDoc
        req.user.points = 0.0

        console.log(`new user: ${insRes.insertedId}`)

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
        await updateGlobalLeaderboard()

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

          const updateRes = await db.updateOne(query, update)

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
    console.log(`insert guess fail, not logged in`)
    next()
  }
  else if (req.body.match_id === undefined || all_matches[req.body.match_id] === undefined) {
    console.log(`insert guess fail, invalid match id: ${req.body.match_id}, user: ${req.user._json.steamid}`)
    next()
  }
  else if (isNaN(req.body.prob) || parseInt(req.body.prob) < 0 || parseInt(req.body.prob) > 100) {
    console.log(`insert guess fail, invalid probability: ${req.body.prob}, user: ${req.user._json.steamid}`)
    next()
  }
  else if (all_matches[req.body.match_id].isComplete || all_matches[req.body.match_id].isLive) {
    console.log(`insert guess fail, match is complete or live: ${req.body.match_id}, user: ${req.user._json.steamid}`)
    next()
  }
  else {
    try {
      const query = { _id: req.user._json.steamid }
      const results = await db.findOne(query)

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

      const updateRes = await db.updateOne(query, update)

      next()
    } 
    catch (err) {
      console.log(`insert guess fail, error: ${err}, user: ${req.user._json.steamid}`)
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
    const results = await db.findOne(query)

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

/* Leaderboard Middleware - NEED TO TEST */

async function getCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`custom leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        res.locals.customLeaderboard = undefined
        next()
      }
      else {
        const leaderboardUsers = JSON.parse(results.users)

        if (req.user._json.steamid in leaderboardUsers) {
          const oldLeaderboard = []
          const newLeaderboard = []

          // CHECK THIS
          for (user in leaderboardUsers) {
            const userInfo = all_user_data[user]

            oldLeaderboard.push({
              user: userInfo.user,
              score: userInfo.score - userInfo.prevDay,
            })
            newLeaderboard.push(userInfo)
          }

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

          res.locals.customLeaderboard = newLeaderboard
          
          // if owner, show requests as well
          if (req.user._json.steamid !== results.admin) {
            res.locals.leaderboardRequests = JSON.parse(results.requests)
          }

          next()
        }
        else {
          console.log(`custom user leaderboard error, user not in custom leaderboard: user ${req.user._json.steamid}, leaderboard ${req.params.leaderboardID}`)
        }
      }
    }
  }
}

async function createCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`create custom leaderboard fail, not logged in`)
      next()
    }
    else if (res.locals.leaderboardsOwned.length >= MAX_LEADERBOARDS) {
      console.log(`create custom leaderboard fail, max leaderboards reached: user ${req.user._json.steamid}`)
      next()
    }
    else {
      let leaderboardID = uuid()
      while (await leaderboard_db.findOne({ _id: leaderboardID }) !== null) {
        leaderboardID = uuid()
      }
      const users = {}
      users[req.user._json.steamid] = true

      const newDoc = {
        _id: leaderboardID,
        name: `${req.user._json.personaname}'s Leaderboard`,
        users: JSON.stringify(users),
        admin: res.locals.userDoc._id,
        requests: JSON.stringify({}),
      }

      const insertRes = await leaderboard_db.insertOne(newDoc)
      console.log(`new custom leaderboard: ${leaderboardID}`)

      next()
    }
  }
}

async function deleteCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`delete custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`delete custom leaderboard fail, leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        next()
      }
      else {
        if (req.user._json.steamid !== results.admin) {
          console.log(`delete custom leaderboard fail, user not admin: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          const deleteRes = await leaderboard_db.deleteOne(query)
          console.log(`deleted custom leaderboard: ${req.params.leaderboardID}`)

          next()
        }
      }
    }
  }
}

async function joinCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`join custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`request custom leaderboard fail, leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        next()
      }
      else {
        const users = JSON.parse(results.users)
        const requests = JSON.parse(results.requests)
        if (req.user._json.steamid in users || req.user._json.steamid in requests) {
          console.log(`request custom leaderboard fail, user already in leaderboard: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          requests[req.user._json.steamid] = true
          const update = { $set: { users: JSON.stringify(requests) } }
          const updateRes = await leaderboard_db.updateOne(query, update)
          console.log(`user requested custom leaderboard: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)

          next()
        }
      }
    }
  }
}

async function acceptCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`accept custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`accept custom leaderboard fail, leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        next()
      }
      else {
        const users = JSON.parse(results.users)
        const requests = JSON.parse(results.requests)
        if (req.user._json.steamid in users) {
          console.log(`accept custom leaderboard fail, user already in leaderboard: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else if (!(req.body.user in requests)) {
          console.log(`accept custom leaderboard fail, user not in requests: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          users[req.body.user] = true
          delete requests[req.body.user]

          const update = { $set: { users: JSON.stringify(users), requests: JSON.stringify(requests) } }
          const updateRes = await leaderboard_db.updateOne(query, update)
          console.log(`user joined custom leaderboard: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)

          next()
        }
      }
    }
  }
}

async function changeCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`change custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`change custom leaderboard fail, leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        next()
      }
      else {
        if (req.user._json.steamid !== results.admin) {
          console.log(`change custom leaderboard fail, user not admin: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          const update = { $set: { name: req.params.name } }
          const updateRes = await leaderboard_db.updateOne(query, update)
          console.log(`name changed custom leaderboard: ${req.params.leaderboardID}`)

          next()
        }
      }
    }
  }
}

async function leaveCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`leave custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`leave custom leaderboard fail, leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        next()
      }
      else {
        const users = JSON.parse(results.users)
        if (!(req.user._json.steamid in users)) {
          console.log(`leave custom leaderboard fail, user not in leaderboard: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          delete users[req.user._json.steamid]

          const update = { $set: { users: JSON.stringify(users) } }

          const updateRes = await leaderboard_db.updateOne(query, update)

          console.log(`user left custom leaderboard: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
      }
    }
  }
}

async function kickUserCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`kick user custom leaderboard fail, not logged in`)
      next()
    }
    else {
      const query = { _id: req.params.leaderboardID }
      const results = await leaderboard_db.findOne(query)

      if (results === null) {
        console.log(`kick user custom leaderboard fail, leaderboard does not exist: ${req.params.leaderboardID}, user ${req.user._json.steamid}`)
        next()
      }
      else {
        if (req.user._json.steamid !== results.admin) {
          console.log(`kick user custom leaderboard fail, user not admin: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          const users = JSON.parse(results.users)
          if (!(req.body.user in users)) {
            console.log(`kick user custom leaderboard fail, user not in leaderboard: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
            next()
          }
          else if (req.body.user === results.admin) {
            console.log(`kick user custom leaderboard fail, cannot kick admin: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
            next()
          }
          else {
            delete users[req.body.user]

            const update = { $set: { users: JSON.stringify(users) } }

            const updateRes = await leaderboard_db.updateOne(query, update)

            console.log(`user kicked from custom leaderboard: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
            next()
          }
        }
      }
    }
  }
}

async function promoteUserCustomLeaderboard(req, res, next) {
  if (!startup_complete) next()
  else {
    if (req.user === undefined || req.user._json === undefined) {
      console.log(`promote user custom leaderboard fail, not logged in`)
      next()
    }
    else {
      if (req.user._json.steamid !== results.admin) {
        console.log(`promote user custom leaderboard fail, user not admin: ${req.user._json.steamid}, leaderboard: ${req.params.leaderboardID}`)
        next()
      }
      else {
        const users = JSON.parse(results.users)
        if (!(req.body.user in users)) {
          console.log(`promote user custom leaderboard fail, user not in leaderboard: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else if (req.body.user === results.admin) {
          console.log(`promote user custom leaderboard fail, cannot promote admin: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
        else {
          const update = { $set: { admin: req.body.user } }

          const updateRes = await leaderboard_db.updateOne(query, update)

          console.log(`user promoted in custom leaderboard: ${req.body.user}, leaderboard: ${req.params.leaderboardID}`)
          next()
        }
      }
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

    res.render('index', { user: req.user, upcomingMatches: upcomingMatches, completedMatches: completedMatches, leaderboard: leaderboardDisplay, logos: TEAM_TO_LOGO, tournamentName: TOURNAMENT_NAME })
  }
})

app.get('/upcomingMatches', [checkDocumentExists, getUpcomingMatches, findUserPlace], (req, res) => {
  if (!startup_complete) {
    res.render('loading')
  }
  else {
    req.session.currLink = '/upcomingMatches'
    res.render('upcoming-matches', { user: req.user, matches: res.locals.upcoming_matches, logos: TEAM_TO_LOGO, userPoints: res.locals.userPoints, userPlace: toOrdinal(res.locals.userPlace), totalUsers: leaderboard.length })
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
    res.render('completed-matches', { user: req.user, matches: res.locals.completed_matches, logos: TEAM_TO_LOGO })
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
    res.render('user-profile', { user: req.user, userInfo: res.locals.userInfo, totalUsers: leaderboard.length, logos: TEAM_TO_LOGO })
  }
})

/* Custom Leaderboard Routes */

app.post('/getCustomLeaderboard', [getCustomLeaderboard], (req, res) => {
  res.send(res.locals.customLeaderboard)
})

app.post('/createCustomLeaderboard', [createCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/deleteCustomLeaderboard', [checkDocumentExists, deleteCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/joinCustomLeaderboard', [joinCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/acceptCustomLeaderboard', [acceptCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/changeCustomLeaderboard', [changeCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/leaveCustomLeaderboard', [leaveCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/kickUserCustomLeaderboard', [kickUserCustomLeaderboard], async (req, res) => {
  res.send()
})

app.post('/promoteUserCustomLeaderboard', [promoteUserCustomLeaderboard], async (req, res) => {
  res.send()
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

app.listen(process.env.PORT || 4000, () => console.log("Server is running..."))

// npx tailwindcss -i .\static\styles.css -o ./static/output.css --watch
