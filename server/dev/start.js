const Morrigan = require('@adicitus/morrigan.server') 
const serverSettings = require('./server.settings')

let morriganServer = new Morrigan(serverSettings)
morriganServer.setup()

const handleStop = (e) => {
    morriganServer.log(`Shutdown signal received: ${e}`)
    morriganServer.stop(e)
}

process.on('SIGTERM', handleStop)
process.on('SIGINT',  handleStop)
process.on('SIGHUP',  handleStop)

morriganServer.start()