"use strict"

const JWTGenerator = require('@adicitus/jwtgenerator')
const { DateTime } = require('luxon')
const {v4: uuidv4} = require('uuid')

var coreEnv = null
var log = null
var tokens = null

var connectionRecords = null
var connectionTokenRecords = null
var sockets = {}
var heartbeats = {}

var callbacks = {
    /**
     * Callable objects to be called when the connection is accepted and the
     * connection record has been commited the DB.
     */
    connect: [],
    /**
     * Callable objects to be called when the connection is authenticated
     * but before the connection record has been committed to the DB.
     * 
     * If the record is modified at this point, those changes will be committed
     * to the DB.
     */
    authenticate: [],
    /**
     * Callable objects to be called when a connection has ended.
     */
    disconnect: []
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

    let closed = false

    if (ws && ws.readyState == 1) {
        ws.close()
        closed = true
    }
    
    let record = await connectionRecords.findOne({ id: connectionId })

    if (record) {
        record.alive = false
        record.open = false
        if (closed) {
            record.disconnected = DateTime.now()
        }

        let heartBeatCheck = heartbeats[connectionId]

        if (heartBeatCheck) {
            clearInterval(heartBeatCheck)
        }

        await connectionRecords.replaceOne({id: connectionId}, record)
    }
}

/**
 * WebSocket connection authorization endpoint.
 * 
 * Expects the body of the request to contain the identity token of a client.
 * 
 * Generates a connection token that can be passed in the origin field when
 * connecting via WebSocket.
 * 
 * @param {object} req Request object
 * @param {object} res Result object
 */
async function ep_wsConnectAuth(req, res) {

    let idtoken = req.headers.authorization

    res.setHeader('Content-Type', 'application/json')

    if (!idtoken) {
        res.status(400)
        res.end(JSON.stringify({ state: 'requestError', reason: `No token provided.` }))
    }

    // Verify that the idenitity token is valid and retriee the client record:
    let r = await coreEnv.providers.client.verifyToken(idtoken)
    
    if (r.state !== 'success') {
        log(`Failed authentication attempt from ${req.connection.remoteAddress}. state: '${r.state}', reason: ${r.reason}`, 'info')
        log(`${req.connection.remoteAddress} sent token '${idtoken}'`, 'debug')
        res.status(403)
        res.end(JSON.stringify(r))
        return
    }
    let client = r.client
    log(`Connection from ${req.connection.remoteAddress} authenticated as '${client.id}'.`, 'debug')

    // Verify that the client is not currently in an active session:
    let c = await connectionRecords.findOne({clientId: client.id})

    if (c) {
        if (c.open && DateTime.fromISO(c.timeout).diffNow().milliseconds >= 0) {
            // If the client has an active connection abort this connection attempt:
            log(`Client '${client.id}' is requesting a new connection token but already has an open connection (${c.id}, timout @ ${c.timeout}), rejecting token request.`, 'warn')
            res.status(400)
            res.end(JSON.stringify({state: 'requestError', reason: `client '${client.id}' already has an open connection ('${c.id}')`}))
            return
        }

        let promises = []
        // If the old connection is inactive, remove it.
        promises.push(connectionRecords.deleteOne({id: c.id}))
        promises.push(connectionTokenRecords.deleteOne({id: c.tokenId}))
        await Promise.all(promises)
    }

    // TODO: Process connection details. Right now we only care about the token but in the future
    // each client should be able to request more than one WebSocket connection, and each connection
    // should be able to have different settings (like specifying that you want a 'stream' connection
    // rather than a 'message'-based one).

    // Generate a new connection connection token and record:
    var record = {
        id: uuidv4(),
        clientId: client.id,
        clientAddress: req.connection.remoteAddress,
        connected: false,
        alive: false,
        open: true,
        reportUrl: `${coreEnv.endpointUrl}/${module.exports.name}/connect`
    }

    record.reportUrl = `${coreEnv.endpointUrl}/${module.exports.name}/connect`

    let tokenR = await tokens.newToken(record.id, { payload: { reportUrl: record.reportUrl } })
    
    record.timeout = tokenR.record.expires

    log(`New connection provisioned (ID: ${record.id}, Token ID: ${tokenR.record.id})`, 'debug')

    record.tokenId = tokenR.record.id
    connectionRecords.insertOne(record)

    res.status(200)
    res.end(JSON.stringify({ state: 'success', token: tokenR.token }))
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

    let token = request.headers.origin

    let r = await tokens.verifyToken(token)

    if (!r.success) {
        log(`WebSocket connection from ${request.connection.remoteAddress} failed authentication. state: '${r.state}', reason: ${r.reason}`, 'warn')
        log(`${request.connection.remoteAddress} sent token: ${JSON.stringify(token)}`, 'debug')
        ws.close()
        return
    } else {
        log(`WebSocket connection from ${request.connection.remoteAddress} passed authentication (connectionId=${r.subject}).`, 'info')
    }

    var record = await connectionRecords.findOne({id: r.subject})
    record.alive = true
    delete(record.timeout)
    record.clientAddress = request.connection.remoteAddress
    record.connected = DateTime.now().toISO()
    record.serverId = coreEnv.serverInfo.id
    sockets[record.id] = ws
    connectionRecords.replaceOne({id: record.id}, record)

    log(`Connection ${record.id} established from ${request.connection.remoteAddress}.`)
    log(`Connection ${record.id} authenticated as client '${record.clientId}'.`)
    
    for (let i in callbacks.authenticate) {
        callbacks.authenticate[i](record, ws)
    }

    // Heartbeat monitor
    heartBeatCheck = setInterval(async () => {
            if (!record.alive) {
                log(`Heartbeat missed by ${request.connection.remoteAddress}`)
                await connectionRecords.replaceOne({id: record.id}, record)
            }
            record.alive = false
            ws.ping()
        },
        30000
    )

    heartbeats[record.id] = heartBeatCheck

    ws.on('pong', async () => {
        record.lastHearbeat = DateTime.now()
        record.alive = true
        await connectionRecords.replaceOne({id: record.id}, record)
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

        for (let i in callbacks.disconnect) {
            callbacks.disconnect[i](record, ws)
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
    for (let i in callbacks.connect) {
        callbacks.connect[i](record, ws)
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
    {route: '/', method: 'post', handler: ep_wsConnectAuth, security: null, openapi: {
        post: {
            tags: ['Connection', 'Authentication'],
            description: "Websocket connection authorization endpoint.",
            summary: "Generate connection authorization tokens.",
            responses: {
                200: {
                    description: "Authentication accepted, a connection token will be returned.",
                    content: {
                        'application/json': {
                            type: 'object',
                            schema: {
                                properties: {
                                    state: {
                                        type: 'string',
                                        pattern: '^success$'
                                    },
                                    token: {
                                        type: 'string',
                                        format: 'jwt'
                                    }
                                }
                            }
                        }
                    }
                },
                400: {
                    description: "Failed to process the request due to errors in the request. See the response for further details."
                },
                403: {
                    description: "Client is not authorized to generate a connection token. See response for further details."
                }
            },
            security: [{ '#/components/securitySchemes/morrigan.providers.connection.clientAuthentication': [] }]
        }
    }},
    {route: '/connect', method: 'ws', handler: ep_wsConnect, security: null,  openapi: {
        get: {
            tags: ['Connection'],
            description: 'WebSocket connection endpoint.',
            summary: "WebSocket connection endpoint",
            security: [{}]
        }
    }},
    {route: '/', method: 'get', handler: ep_getConnections, openapi: {
            get: {
                tags: ['Connection'],
                description: "Retrieve a list of connections.",
                summary: "Retrieve list of all connections in the system",
                responses: {
                    200: {
                        description: "Successfully list the connections. This will be an empty array if there are no connections.",
                        content: {
                            'application/json': {
                                schema: {
                                    type: 'array',
                                    items: { $ref: '#/components/schemas/connection.connectionRecord' }
                                }
                            }
                        }
                    }
                }
            }
        }
    },
    {route: '/:connectionId', method: 'get', handler: ep_getConnections, openapi: {
        get: {
            tags: ['Connection'],
            description: "Attempt to retrieve information about the connection with the given connectionId.",
            summary: "Attempt to retrieve information about a given connection",
            parameters: [
                { $ref: '#/components/parameters/connectionId' }
            ],
            responses: {
                200: {
                    description: "Returns a connection with the given ID.",
                    content: {
                        'application/json': {
                            schema: { $ref: '#/components/schemas/connection.connectionRecord' }
                        }
                    }
                },
                204: {
                    description: "Nothing to return, no such connection."
                }
            }
        }
    }},
    {route: '/:connectionId/send', method: 'post', handler: ep_send, openapi: {
        post: {
            tags: ['Connection'],
            description: "Attempt to send a message via the connection with the given connectionId.",
            summary: "Attempt to send a message over a connection.",
            requestBody: { $ref: '#/components/requestBodies/connection.send.message' },
            parameters: [
                { $ref: '#/components/parameters/connectionId' }
            ],
            responses: {
                200: {
                    description: "Successully sent the message."
                },
                400: {
                    description: "Failed to send the message due to invalid paramters.",
                    content: {
                        'application/json': {
                            schema: {
                                properties: {
                                    status: {
                                        description: `Status of the send request. This will be 'failed' in all cases.`,
                                        type: 'string',
                                        pattern: '^failed$'
                                    },
                                    reason: {
                                        description: 'A more detailed, human-readable description of the failure.',
                                        type: 'string'
                                    }
                                }
                            },
                            examples: {
                                'Missing connection ID': { value: { status: 'failed', reason: 'No connectionId specified.' } },
                                'Missing message': { value: { status: 'failed', reason: 'No message specified.' } },
                                'Missing message type': { value: { status: 'failed', reason: 'No message type specified.' } }
                            }
                        }
                    }
                },
                403: {
                    description: "The user does not have 'send' privilege (function 'connection.send').",
                    content: {
                        'application/json': {
                            schema: {
                                status: {
                                    description: `Status of the send request. This will be 'failed' in all cases.`,
                                    type: 'string',
                                    pattern: '^failed$'
                                },
                                reason: {
                                    description: 'A more detailed, human-readable description of the failure.',
                                    type: 'string'
                                }
                            },
                            example: { status: 'failed', reason: 'Send not permitted.' } 
                        }
                    }
                }
            }
        }
    }}
]
module.exports.functions = [
    'api',
    'connection',
    'connection.send'
]

module.exports.setup = async (env, providers)  => {
    coreEnv = env
    coreEnv.providers = providers
    log = env.log
    

    connectionRecords = env.db.collection('morrigan.connections')
    connectionTokenRecords = env.db.collection('morrigan.connections.tokens')

    tokens = new JWTGenerator({id: env.serverInfo.id, tokenLifetime: {seconds: 60}, collection: connectionTokenRecords})
}

module.exports.onShutdown = async () => {
    log('Server is shutting down, ending all connections...')
    for (const cid in sockets) {

        log (`Closing connection ${cid}...`)

        cleanup(cid)
    }
}

/**
 * Add a handler for a given event on this provider.
 * 
 * @param {string} eventName Name of the event to add handler for.
 * @param {function} handler The handler to add.
 */
module.exports.on = (eventName, handler) => {
    if (!Object.keys(callbacks).includes(eventName)) {
        log(`Invalid event name specified: '${eventName}'`, 'error')
        return
    }

    callbacks[eventName].push(handler)
}

/**
 * REmove a handler for a given event on this provider.
 * 
 * @param {string} eventName Name of the event to remove handler for. 
 * @param {function} handler The handler to remove
 */
module.exports.off = (eventName, handler) => {
    if (!Object.keys(callbacks).includes(eventName)) {
        log(`Invalid event name specified: '${eventName}'`, 'error')
        return
    }

    callbacks[eventName] = callback[eventName].filter(v => v !== handler )
}

module.exports.send = send

module.exports.openapi = {
    components: {
        parameters: {
            'connectionId': {
                description: "ID of a connection in the system.",
                name: 'connectionId',
                in: 'path',
                required: true,
                allowEmptyValue: false,
                schema: {
                    type: 'string',
                    format: 'uuid'
                }
            }
        },
        requestBodies: {
            'connection.send.message': {
                description: "Message to send to a client connected via WebSocket. The exact format of the message depends on the intended message recipient, but all messages should include the 'type' property to indicate the recipient(s).",
                content: {
                    'application/json': {
                        schema: {
                            required: ['type'],
                            properties: {
                                type: {
                                    description: 'Type of message to send',
                                    type: 'string'
                                }
                            }
                        }
                    }
                },
                required: true
            }
        },
        schemas: {
            'connection.connectionRecord': {
                type: 'object',
                properties: {
                    _id: {
                        description: "Internal ID of the connection record.",
                        type: 'string'
                    },
                    id: {
                        description: "ID of this connection record.",
                        type: 'string',
                        format: 'uuid'
                    },
                    clientAddress: {
                        description: 'Remote IP-address of the connecting client.',
                        type: 'string',
                        format: 'IP Address'
                    },
                    clientId: {
                        description: "ID of the client that requiisitioned this connection.",
                        type: 'string',
                        format: 'UUID'
                    },
                    serverId: {
                        description: "The ID of the server where this connection is avaialable.",
                        type: 'string',
                        format: 'uuid'
                    },
                    connected: {
                        description: "Indicates whether the client has connected to this endpoint."
                    },
                    disconenceted: {
                        description: "Indicates when the connection was ended."
                    },
                    alive: {
                        description: "Indicates whether this connection is active.",
                        type: 'boolean'
                    },
                    open: {
                        description: "Indicates whether the connection endpoint is available for this connection.",
                        type: 'boolean'
                    },
                    timeout: {
                        description: 'Date and time when this connection will cease to be valid unless a connection is made.',
                        type: 'string',
                        format: 'ISO 8601 Datetime'
                    },
                    lastHeartbeat: {
                        description: 'Date and time of the last heartbeat.',
                        type: 'string',
                        format: 'ISO 8601 Datetime'
                    },
                    reportUrl: {
                        description: "The URL to which the client should connect when establishing the connection."
                    }
                }
            }
        },
        securitySchemes: {
            'morrigan.providers.connection.clientAuthentication': {
                description: "Authentication used by client to interact with the 'connection' API.",
                type: 'http',
                scheme: 'bearer',
                bearerFormat: 'jwt'
            }
        }
    },
    tags: [{ name: 'Connection', description: "WebSocket connections form the basis of communication in the system." }]
}