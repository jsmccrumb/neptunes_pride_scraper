const initGame = `// merge on game id so it starts getting tracked
  MERGE (g:Game {gameId: $gameId})
`;

const getGames = `// get currently active games
  MATCH (g:Game) WHERE (NOT g.isOver) OR g.isOver IS NULL
  RETURN g.gameId AS gameId
`;

const loadData = `// load JSON of full nepture report
    CALL apoc.load.json($fileName) YIELD value
    MERGE (g:Game {gameId: $gameId})
    SET g.name = value.report.name,
        g.turnBased = (value.report.turn_based = 1),
        g.starsForVictory = value.report.stars_for_victory,
        g.totalStars = value.report.total_stars,
        g.productions = value.report.productions,
        g.startTime = value.report.start_time,
        g.isOver = value.report.game_over <> 0
    WITH g, value
    UNWIND keys(value.report.stars) AS starKey
    WITH g, value, starKey, value.report.stars[starKey] AS starInfo
    MERGE (g)-[:HAS_STAR]->(s:Star {starKey: starInfo.uid})
    SET s.name = starInfo.n,
        s.x = starInfo.x,
        s.y = starInfo.y,
        s.naturalResources = coalesce(starInfo.nr, s.naturalResources)
    WITH DISTINCT g, value
    OPTIONAL MATCH (g)-[:HAS_LOG_FOR]->(t:Tick) WHERE NOT (t)-[:NEXT_TICK]->() AND NOT t.tick = value.report.tick
    MERGE (g)-[:HAS_LOG_FOR]->(ct:Tick {tick: value.report.tick})
            ON CREATE SET ct.newReport = true
        ON MATCH SET ct.newReport = false
    WITH g, ct, value, t WHERE ct.newReport
    MERGE (t)-[:NEXT_TICK]->(ct)
    WITH DISTINCT g, ct, value
    UNWIND keys(value.report.players) AS playerKey
    WITH g, playerKey, value, ct, value.report.players[playerKey] AS playerInfo
    MERGE (g)-[:HAS_PLAYER]->(p:Player {playerKey: playerInfo.uid})
    SET p.alias = playerInfo.alias,
        p.ready = playerInfo.ready,
        p.ai = playerInfo.ai,
        p.missedTurns = playerInfo.missed_turns
    MERGE (p)-[:HAS_FLEET]->(f:Fleet)-[:DURING]->(ct)
    SET f.ships = playerInfo.total_strength,
            f.carriers = playerInfo.total_fleets
    MERGE (p)-[:HAS_EMPIRE]->(e:Empire)-[:DURING]->(ct)
    SET e.cash = playerInfo.cash,
            e.totalStars = playerInfo.total_stars,
        e.totalScience = playerInfo.total_science,
        e.totalIndustry = playerInfo.total_industry,
        e.totalEconomy = playerInfo.total_economy,
        e.starsAbandoned = playerInfo.stars_abandoned
    MERGE (p)-[:HAS_SCIENCE]->(s:Science)-[:DURING]->(ct)
    SET s.banking = playerInfo.tech.banking.level,
            s.weapons = playerInfo.tech.weapons.level,
        s.manufacturing = playerInfo.tech.manufacturing.level,
        s.scanning = playerInfo.tech.scanning.level,
        s.terraforming = playerInfo.tech.terraforming.level,
        s.hyperspaceRange = playerInfo.tech.propulsion.level,
        s.experimentation = playerInfo.tech.research.level,
        s.researching = playerInfo.researching
    WITH DISTINCT g, value, ct
    UNWIND keys(value.report.stars) AS starKey
    WITH g, value, ct, starKey, value.report.stars[starKey] AS starInfo
    WHERE starInfo.puid >= 0
    MATCH (s {starKey: starInfo.uid})<-[:HAS_STAR]-(g)-[:HAS_PLAYER]->({playerKey: starInfo.puid})-[:HAS_EMPIRE]->(e)-[:DURING]->(ct)
    MERGE (s)-[ie:IN_EMPIRE]->(e)
    ON CREATE SET ie.totalResource = starInfo.r,
            ie.science = starInfo.s,
        ie.economy = starInfo.e,
        ie.industry = starInfo.i,
        ie.ships = starInfo.st,
        ie.ga = starInfo.ga,
        ie.g = starInfo.g,
        ie.v = starInfo.v
    WITH DISTINCT g, ct, value
    UNWIND keys(value.report.fleets) AS fleetKey
    WITH g, value, ct, fleetKey, value.report.fleets[fleetKey] AS fleetInfo
    MERGE (c:Carrier {carrierKey: fleetInfo.uid})<-[:HAS_CARRIER]-(g)
    WITH g, value, ct, fleetKey, fleetInfo, c
    MATCH (g)-[:HAS_PLAYER]->({playerKey: fleetInfo.puid})-[:HAS_FLEET]->(f)
    SET c.name = fleetInfo.n
    MERGE (c)-[r:IN_FLEET]->(f)
    ON CREATE SET r.lx = fleetInfo.lx,
        r.ly = fleetInfo.ly,
        r.x = fleetInfo.x,
        r.y = fleetInfo.y,
        r.l = fleetInfo.l,
        r.ships = fleetInfo.st,
    r.waypoints = reduce(sum = [], star in fleetInfo.o | sum + star[1])`;

const trackScience = `// load JSON and check for buying techs
WITH datetime() AS currentTime
CALL apoc.load.json($fileName) YIELD value
MATCH (g:Game {gameId: $gameId})-[:HAS_LOG_FOR]->(ct:Tick {tick: value.report.tick})
UNWIND keys(value.report.players) AS playerKey
WITH g, playerKey, value, ct, value.report.players[playerKey] AS playerInfo, currentTime
MATCH (g)-[:HAS_PLAYER]->(p:Player {playerKey: playerInfo.uid})-[:HAS_SCIENCE]->(s:Science)-[:DURING]->(ct)
UNWIND [{prop: 'banking', key: 'banking'},
  {prop: 'weapons', key: 'weapons'},
  {prop: 'manufacturing', key: 'manufacturing'},
  {prop: 'scanning', key: 'scanning'},
  {prop: 'terraforming', key: 'terraforming'},
  {prop: 'hyperspaceRange', key: 'propulsion'},
  {prop: 'experimentation', key: 'research'}] AS keyMap
WITH g, ct, p, s, value, playerInfo, keyMap, currentTime
WHERE s[keyMap.prop] <> playerInfo.tech[keyMap.key].level AND NOT (s)-[:BUYS {type: keyMap.prop, value: playerInfo.tech[keyMap.key].level}]->()
MATCH (g)-[:HAS_PLAYER]->()-[:HAS_SCIENCE]->(otherSci)-[:DURING]->(ct)
WHERE otherSci[keyMap.prop] > s[keyMap.prop]
MERGE (s)-[:BUYS {type: keyMap.prop, value: playerInfo.tech[keyMap.key].level, dateTime: currentTime}]->(otherSci)
WITH s, otherSci, g, ct, p, currentTime, value, playerInfo, keyMap
MATCH (thirdSci)-[b:BUYS {type: keyMap.prop}]->(otherSci)
WHERE b.value > s[keyMap.prop] AND b.dateTime < currentTime
MERGE (s)-[:BUYS {type: keyMap.prop, value: playerInfo.tech[keyMap.key].level, dateTime: currentTime}]->(thirdSci)`;

const shipsLost = `// ships lost info
MATCH (ct)<-[:NEXT_TICK]-(pt)<-[:HAS_LOG_FOR]-(g:Game)-[:HAS_PLAYER]->(p),
	(p)-[:HAS_FLEET]->(pf)-[:DURING]->(pt),
    (p)-[:HAS_FLEET]->(cf)-[:DURING]->(ct),
    (p)-[:HAS_EMPIRE]->(ce)-[:DURING]->(ct),
    (p)-[:HAS_SCIENCE]->(cs)-[:DURING]->(ct)
WITH g, p, pt, ct, pf, cf, ce, cs, toFloat(ce.totalIndustry * (5 + cs.manufacturing)) / 24.0 * toFloat(ct.tick - pt.tick) AS expectedGain
WITH g, p, pt, ct, pf, cf, ce, cs, expectedGain, cf.ships - pf.ships AS actualGain
WHERE expectedGain - actualGain > 5
RETURN g.name, p.alias, ct.tick, actualGain, expectedGain, expectedGain - actualGain AS lost
ORDER BY g.name, ct.tick DESC, (expectedGain - actualGain) DESC`;

const starsStolen = `// stolen stars
MATCH (p1)-[:HAS_EMPIRE]->(e1)<-[:IN_EMPIRE]-(s:Star)-[:IN_EMPIRE]->(e2)<-[:HAS_EMPIRE]-(p2), path=(e2)-[:DURING]->(t2)<-[:NEXT_TICK]-(t1)<-[:DURING]-(e1)
WHERE p1 <> p2
WITH p1, p2, s, min(t2.tick) AS takenTick, max(t1.tick) AS lastOwnedTick
RETURN p1.alias AS startPlayer, p2.alias AS endPlayer, s.name AS star, lastOwnedTick, takenTick ORDER BY takenTick DESC, p1.alias, p2.alias`;

const buyingScience = `// whos buying from whom
MATCH (g)-[:HAS_PLAYER]->(p:Player {alias: 'M4Matt'})-[:HAS_SCIENCE]->(s)-[:DURING]->(t),
(s)-[b:BUYS]->(os)<-[:HAS_SCIENCE]-(op)
RETURN g.name, t.tick, p.alias, b.type, b.value, collect(DISTINCT(op.alias)) ORDER BY g.name, t.tick DESC`;

const empireBuildup = `// civ advancement
MATCH (g)-[:HAS_PLAYER]->(p:Player {alias: 'M4Matt'})-[:HAS_EMPIRE]->(e)-[:DURING]->(t)
RETURN g.name, t.tick, p.alias, e.totalIndustry, e.totalEconomy, e.totalScience ORDER BY g.name, t.tick DESC`;

module.exports = {trackScience, loadData, getGames, initGame, shipsLost, starsStolen, buyingScience, empireBuildup};
