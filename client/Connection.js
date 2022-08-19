const WebSocket = require('ws')

/**
 * Creates a new connection object. that can be used to create a WebSocket connection to a Morrigan system endpoint.
 * 
 * @param {string} token Client identity token.
 * @param {string} reportUrl URL to morrigan system connection endpoint.
 * @param {function} log Log function to use.
 * @param {object} settings Additional optional settings. The only setting available at this time is 'alwaysReconnect'
 * @returns A connection object that can be used to connect to a Morrigan server.
 */
function Connection(token, reportUrl, log, settings) {
    
    /**
     * Internal hidden state for this connection object.
     */
    let _state = {
        token: token,
        reportUrl: reportUrl,
        ws: null,
        handlers: {
            connect: [],
            disconnect: [],
            message: []
        },
        http: (reportUrl.match(/^https/i)) ? require('https') : require('http')
    }


    /**
     * If this is set to true, the connection will try to reconnect every 30 seconds
     * if the connection is closed on the server side.
     */
    this.alwaysReconnect = false

    // Apply settings here:
    if (settings) {
        this.alwaysReconnect = settings.alwaysReconnect || this.alwaysReconnect
    }

    /**
     * Register an event handler for an event on this connection.
     * 
     * 3 events are available:
     *  - 'connect': Called when connection is established (parameter is the underlying WebSocket connection).
     *  - 'disconnect': Called when connection is disconnected (parameter is the underlying WebSocket connection).
     *  - 'message': Called when a message is received (Paramter is the received message).
     * 
     * @param {string} eventName Name of the event
     * @param {function} handler The function to call
     */
    this.on = (eventName, handler) => {
        
        if (!handler) {
            return
        }

        if (!Object.keys(_state.handlers).includes(eventName)) {
            throw new Error(`Invalid event name '${eventName}'`)
        }

        _state.handlers[eventName].push(handler)
    }

    /**
     * Unregisters an event handler for an event on this connection.
     * @param {string} eventName Name of the event ('connect', 'disconnect' & 'message').
     * @param {function} handler The function to remove
     */
    this.off = (eventName, handler) => {

        if (!handler) {
            return
        }

        if (!Object.keys(_state.handlers).includes(eventName)) {
            throw new Error(`Invalid event name '${eventName}'`)
        }

        _state.handlers[eventName] = _state.handlers[eventName].filter(v => v !== handler)
    }

    /**
     * Try to connect to a server.
     */
    this.connect = () => {

        let self = this
        let traceId = Math.random().toString(16).split('.')[1]

        log(`Getting WebSocket authorization from ${_state.reportUrl}...`)
        
        let req = _state.http.request(_state.reportUrl, {
            method: 'post',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': _state.token
            }
        })

        req.write(JSON.stringify({ idtoken: _state.token, traceId: traceId }))

        req.on('response', (res) => {
            
            log(`Started receiving response for Authorization request...`)

            res.setEncoding('utf8')
            
            res.on('data', (chunk) => {

                if (res.statusCode !== 200) {
                    log(`Received response with status ${res.statusCode} from ${_state.reportUrl}, indicating that we failed to retrieve an authorization token. Aborting connection.`, 'warn')
                    return
                }

                let authToken = null
                try {
                    let responseRaw = chunk
                    console.log(responseRaw)
                    authToken = JSON.parse(responseRaw).token
                } catch(e) {
                    e._traceId = Math.random().toString(16).split('.')[1]
                    log(`Unable to parse WebSocket authorization returned from server (trace ID ${e._traceId}): ${e.message}`, 'error')
                    log(JSON.stringify(e), 'debug')
                    return
                }

                let payloadRaw = authToken.split('.')[1]
                let payloadString = Buffer.from(payloadRaw, 'base64').toString()
                let payload = JSON.parse(payloadString)

                log(payloadString, 'debug')

                log(`Opening WebSocket connection to '${payload.reportUrl}'`)

                _state.ws = new WebSocket(payload.reportUrl, { origin: authToken })

                _state.ws.on('error', (e) => {
                    log(`Failed to contact server: ${e}`)
                })
        
                _state.ws.on('open', () => {
                    log(`Connection to server opened.`)

                    for (const n in _state.handlers.connect) {
                        try {
                            _state.handlers.connect[n](_state.ws)
                        } catch (e) {
                            log(`Exception occured while processing 'connect' handlers: ${e}`)
                        }
                    }
        
                })
        
                _state.ws.on('message', (message) => {
        
                    try {
                        var msg = JSON.parse(message)
                    } catch (e) {
                        log(`Invalid message received from server (not valid JSON): ${message}`)
                        return
                    }
        
                    if (!msg.type) {
                        log(`Invalid message received from server (no type declaration): ${message}`)
                        return
                    }
        
                    let m = msg.type.match(/^(?<provider>[A-z0-9\-_]+)\.(?<message>[A-z0-9\-_.]+)$/)
        
                    if (!m) {
                        log(`Invalid message received from server (invalid type format): ${message}`)
                        return
                    }
        
                    _state.handlers.message.forEach(h => {
                        try {
                            h(msg, _state.ws)
                        } catch (e) {
                            log(`Exception occured while processing 'message' handlers: ${e}`)
                        }
                    })
        
                })
        
                _state.ws.on('close', (e) => {
                    log(`Connection to server closed`)
                    
                    for (const n in _state.handlers.disconnect) {
        
                        try {
                            _state.handlers.disconnect[n](_state.ws)
                        } catch(e) {
                            log(`Exception occured while processing 'disconnect' handlers: ${e}`)
                        }
                    }
        
                    if (self.alwaysReconnect) {
                        log(`Attempting to reconnect in 30 seconds: ${e}`)
                        self.nextConnectionAttempt = setTimeout(() => {
                            self.nextConnectionAttempt = null
                            self.connect()
                        }, self.reconnectIntervalSeconds * 1000)
                    }
                })
            })
        })
        
        req.on('error', error => {
            error._traceId = traceId
            log(`Failed to retrieve an authorization token for WebSocket connection due to an unexpected error (trace ID ${traceId}): ${error.message}`, 'error')
            log(JSON.stringify(error), 'debug')
        })

        //req.write(JSON.stringify({ idtoken: _state.token, traceId: traceId }))
        log(`Sending request to '${_state.reportUrl}' (trace ID ${traceId})...`)
        req.end()


    }

    /**
     * Sends a message to the server.
     * 
     * @param {object} message Message object to send. 
     */
    this.send = (message) => {
        // 1. Verify state of connection to server:
        if (!_state.ws) {
            throw new Error(`Unable to send message: No WebSocket connection established.`)
        }

        if (_state.ws.readyState !== 1) {
            throw new Error(`Unable to send message: WebSocket connection was in a non-ready state (found '${_state.ws.readyState}', expected '1')`)
        }

        // 2. Verify that message format is correct:
        if (typeof message.type !== 'string') {
            throw new Error(`Unable to send message: Invalid message 'type' declaration (found '${typeof message.type}', expected 'string')`)
        }

        // 3. Send message
        _state.ws.send(JSON.stringify(message))
    }

    this.disconnect = (e) => {
        if (!_state.ws) {
            // No WebSocket connection created, nothing to do.
            return
        }

        let connection = _state.ws
        log(e)
        this.alwaysReconnect = false
        if (connection.readyState === 1) {
            connection.send(JSON.stringify({
                type: 'client.state',
                state: `stopped.${e}`
            }))
            connection.close()

            /*
             * Calling 'onDisconnect' handlers here because the 'close' event
             * on ws connection objects does not get called when the 'close'
             * method is called.
             */
            _state.handlers.disconnect.forEach(h => {
                try {
                    h(connection)
                } catch(e) {
                    log(`Exception occured while processing 'disconnect' handlers: ${e}`)
                }
            })
        }
    }

    return this
}

module.exports = (...args) => {
    return new Connection(...args)
}