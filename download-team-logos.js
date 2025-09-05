const sharp = require('sharp')

const { HLTV } = require('hltv-next')
const { TOURNAMENT_ID } = require('./constants')

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function downloadImage(url, id) {
  await delay(2000)
  const fixedURL = url.replaceAll('&amp;', '&')

  const picture = await (await fetch(fixedURL)).blob()
  const arrayBuffer = await picture.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  sharp(buffer).png().toFile(`static/imgs/${id}.png`, (err, info) => {
    if (err) console.log(err)
  })
}

async function main() {
  const event = await HLTV.getEvent({id: TOURNAMENT_ID})
  const teams = event.teams

  for (let i = 0; i < teams.length; i++) {
    await delay(1000)
    const team = teams[i]
    const team_id = team.id

    const teamData = await HLTV.getTeam({id: team_id})
    if (teamData.logo != undefined) {
      console.log(`Downloading logo for ${team.name} from ${teamData.logo}`)
      const logoURL = teamData.logo[0] === '/' ? `https://www.hltv.org${teamData.logo}` : teamData.logo
      await downloadImage(logoURL, team.id)
    }
  }
}

main()
