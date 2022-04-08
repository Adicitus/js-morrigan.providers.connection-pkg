"use strict"

const { DateTime } = require('luxon')
const {v4: uuidv4} = require('uuid')

var coreEnv = null
var log = null

var connectionRecords = null
var sockets = {}
var heartbeats = {}

var callbacks = {
    onConnect: [],
    onAuthenticate: [],
    onDisconnect: []
}

/**
 * Sends the given message object accross the given connection.
 * @param {string} connectionId The ID of the connection through which to send the message.
 * @param {object} message The message to send.
 */
var send = async (connectionId, message) => {
    let r = await connectionRecords.findOne({id: connectionId})

    if (!r) {
        return { status: 'failed', reason: 'No such connection.' }
    }

    if (!r.isAlive || !r.open ) {
        return { status: 'failed', reason: 'Connection closed or client not live.' }
    }

    if (r.serverId !== coreEnv.serverInfo.id) {
        return { status: 'failed', reason: `Connection '${connectionId}' does not belong to this server ('${coreEnv.serverInfo.id}').` }
    }

    let msg = null

    switch(typeof(message)) {
        case 'string': { msg = message }
        default: {msg = JSON.stringify(message)}
    }

    let s = sockets[connectionId]

    s.send(msg)

    return {status: 'success'}
}


/**
 * Closes the given connection and frees up any associated resources.
 * @param {string} connectionId The ID of the connection to close.
 */
async function cleanup (connectionId) {

    let ws = sockets[connectionId]
    delete sockets[connectionId]

    if (ws && ws.readyState == 1) {
        ws.close()
    }
    
    let record = await connectionRecords.findOne({id: connectionId})
    
    if (record) {
        record.isAlive = false
        record.open = false

        let heartBeatCheck = heartbeats[connectionId]

        if (heartBeatCheck) {
            clearInterval(heartBeatCheck)
        }

        await connectionRecords.replaceOne({id: connectionId}, record)
    }
}

/**
 * WebSocket connection endpoint.
 * 
 * This is the heart of Morrigan.
 * 
 * The endpoint expects a valid client authentication token provided as the origin of the connection.
 * 
 * If a valid token is not provided the connection will be closed.
 * 
 * If the connection origin token is validated, a 'connection.state' message
 * with the value 'accepted' will be sent to the client.  
 * 
 * The resulting connection will be used to send and receive messages as JSON strings.
 * 
 * @param {Object} ws WebSocket Connection. 
 * @param {Object} request Express request object.
 */
async function ep_wsConnect (ws, request) {
    
    var heartBeatCheck = null

    var record = {
        id: uuidv4(),
        clientAddress: request.connection.remoteAddress,
        authenticated: false,
        isAlive: true,
        open: true
    }

    log(`Connection ${record.id} established from ${request.connection.remoteAddress}`)
    sockets[record.id]  = ws

    let r = await coreEnv.providers.client.verifyToken(request.headers.origin)

    if (r.state !== 'success') {
        log(`${record.id} failed authentication attempt. state: '${r.state}', reason: ${r.reason}`)
        log(`Client sent invalid token, closing connection`)
        cleanup(record.id)
        return
    }

    let client = r.client

    log(`Connection ${record.id} authenticated as '${client.id}'.`)

    let c = await connectionRecords.findOne({clientId: client.id})

    if (c) {
        // If the client has an active connection abort this connection attempt:
        if (c.isAlive) {
            log(`Client '${client.id}' is already active in connection ${c.id}. Closing this connection.`)
            await cleanup(record.id)
            return
        }

        // If the old connection is inactive, remove it.
        connectionRecords.deleteOne({id: c.id})
    }

    record.authenticated = true
    record.clientId = client.id
    record.serverId = coreEnv.serverInfo.id
    
    for (let i in callbacks.onAuthenticate) {
        callbacks.onAuthenticate[i](record, ws)
    }

    connectionRecords.insertOne(record)

    // Heartbeat monitor
    heartBeatCheck = setInterval(() => {
            if (!record.isAlive) {
                log(`Heartbeat missed by ${request.connection.remoteAddress}`)
            }
            record.isAlive = false
            ws.ping()
        },
        30000
    )

    heartbeats[record.id] = heartBeatCheck

    ws.on('pong', () => {
        record.lastHearbeat = DateTime.now()
        record.isAlive = true
    })

    ws.on('message', (message) => {
        try {
            var msg = JSON.parse(message)
        } catch(e) {
            log(`Invalid JSON received: ${message}`)
            return
        }

        if(!msg.type) {
            log(`Message without type declaration: ${message}`)
            return
        }

        let m = msg.type.match(/^(?<provider>[A-z0-9\-_]+)\.(?<message>[A-z0-9\-_.]+)$/)

        if (!m) {
            log(`Message with invalid message type: ${message}`)
            return
        }

        let p = coreEnv.providers[m.groups.provider]

        if (!p) {
            log(`No provider for the message type: ${message}`)
            return
        }

        let h = p.messages[m.groups.message]

        if (!h) {
            log(`No handler defined for the message type: ${message}`)
            return
        }

        try {
            h(msg, ws, record, coreEnv)
        } catch(e) {
            log (`Exception thrown while handling message (${m.groups.message}): ${e}`)
        }
    })

    ws.on('close', () => {
        log(`Connection ${record.id} closed (client: ${record.clientId}).`)
        let client = coreEnv.providers.client.getClient(record.clientId)
        if (client) {
            if (!client.state || !client.state.match(/^stopped/)) {
                client.state = 'unknown'
            }
        }

        for (let i in callbacks.onDisconnect) {
            callbacks.onDisconnect[i](record, ws)
        }

        cleanup(record.id)
    })

    ws.send(
        JSON.stringify({
            type: 'connection.state',
            state: 'accepted'
        })
    )

    /**
     * Calling onConnect callbacks to let other providers react to the connection.
     */
    for (let i in callbacks.onConnect) {
        callbacks.onConnect[i](record, ws)
    }

    log(`Connection ${record.id} is ready.`)

}

async function ep_getConnections(req, res) {

    if (req.params) {

        let params = req.params

        if (params.connectionId) {
            let c = connectionRecords.findOne({id: params.connectionId})
            if (c) {
                res.status(200)
                res.send(JSON.stringify(c))
                return
            } else {
                res.status(204)
                res.end()
                return
            }
        }
        
    }

    let cs = await connectionRecords.find().toArray()

    res.status(200)
    res.send(JSON.stringify(cs))
}

function ep_send(req, res) {
    if (!req.authenticated.functions.includes('connection.send')) {
        res.status(403)
        res.send(JSON.stringify({ status: 'failed', reason: 'Send not permitted.' }))
        return
    }

    if (!req.params.connectionId) {
        res.status(400)
        res.send(JSON.stringify({ status: 'failed', reason: 'No connectionId specified.' }))
        return
    }

    if (!req.body) {
        res.status(400)
        res.send(JSON.stringify({ status: 'failed', reason: 'No message specified.' }))
        return
    }

    let msg = req.body

    if (!msg.type) {
        res.status(400)
        res.send(JSON.stringify({ status: 'failed', reason: 'No message type specified.' }))
        return
    }

    let cid = req.params.connectionId
    let r = send(cid, msg)

    if (r.status === 'success') {
        res.status(200)
    } else {
        res.status(400)
    }

    res.send(JSON.stringify(r))
}

module.exports.name = 'connection'

module.exports.endpoints = [
    {route: '/connect', method: 'ws', handler: ep_wsConnect},
    {route: '/', method: 'get', handler: ep_getConnections},
    {route: '/:connectionId', method: 'get', handler: ep_getConnections},
    {route: '/:connectionId/send', method: 'post', handler: ep_send}
]
module.exports.functions = [
    'api',
    'connection',
    'connection.send'
]

module.exports.setup = async (env)  => {
    coreEnv = env
    log = env.log

    connectionRecords = env.db.collection('morrigan.connections')
}

module.exports.onShutdown = async () => {
    log('Server is shutting down, ending all connections...')
    for (const cid in sockets) {

        log (`Closing connection ${cid}...`)

        cleanup(cid)
    }
}

/**
 * Adds a callable object to be called when the connection is accepted and the
 * connection record has been commited the DB.
 * 
 * @param {Object} callback Callable object.
 */
module.exports.onConnect = (callback) => {
    callbacks.onConnect.push(callback)
}

/**
 * Adds a callable object to be called when the connection is authenticated
 * but before the connection record has been committed to the DB.
 * 
 * If the record is modified at this point, those changes will be committed
 * to the DB.
 * 
 * @param {Object} callback Callable object.
 */
module.exports.onAuthenticate = (callback) => {
    callbacks.onAuthenticate.push(callback)
}

module.exports.onDisconnect = (callback) => {
    callbacks.onDisconnect.push(callback)
}

module.exports.send = send