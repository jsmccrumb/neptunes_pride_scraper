const fs = require('fs');
const neo4j = require('neo4j-driver').v1;
const driver = neo4j.driver(process.env.NEO4J_BOLT, neo4j.auth.basic(process.env.NEO4J_USER, process.env.NEO4J_PASS), {maxTransactionRetryTime: 30000});
const request = require('request');
const jar = request.jar();
const loginUrl = 'https://np.ironhelmet.com/arequest/login';
const dataUrl = 'https://np.ironhelmet.com/grequest/order';
const queries = require('./cypher_queries');

const performLogin = (cb) => {
  request.post({url: loginUrl, form: {alias: process.env.NEPTUNE_USER, password: process.env.NEPTUNE_PASS, type: 'login'}, jar: jar}, (err, httpResponse, body) => {
    if (err) return console.error('error in login', err);
    cb && cb();
  });
};

const getData = (gameId, cb) => {
  const fileName = `report_game${gameId}_${Date.now()}.json`;
  request.post({url: dataUrl, form: {type: 'order', order: 'full_universe_report', game_number: gameId, version: 7}, jar: jar})
    .on('error', (err) => console.error('error in get data', err))
    .pipe(fs.createWriteStream(process.env.BASE_IMPORT_PATH + fileName))
    .on('close', () => loadData(gameId, fileName));
}

const loadData = (gameId, fileName) => {
  const session = driver.session();
  session.writeTransaction((tx) => {
    tx.run(queries.loadData, {gameId, fileName});
    return tx.run(queries.trackScience, {gameId, fileName});
  }).then((res) => {
    console.log('data loaded: ', gameId);
    session.close();
  }).catch((err) => {
    console.error('ERROR in load data: ', err);
    session && session.close && session.close();
  });
};

const getOpenGames = () => {
  const session = driver.session();
  session.readTransaction(tx => tx.run(queries.getGames))
    .then((resp) => {
      performLogin(function loopOverRecords() { 
        for (let record of resp.records) {
          getData(record.get('gameId'));
        }
      });
    }).catch(err => console.error('ERROR in get open games', err));
}

setInterval(() => {
  console.log('checking for stats for running games...');
  getOpenGames();
}, 1800000);
driver.onCompleted = () => {
  console.log('Neptune data scraper initialized... checking data now!');
  getOpenGames();
};
