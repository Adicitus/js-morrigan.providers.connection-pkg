const Connection = require('./Connection')
var connection = null

module.exports = {
    name: 'connection',

    setup: (coreEnv) => {
        connection = Connection(coreEnv.providers.client.getToke(), coreEnv.settings.reportUrl, coreEnv.log)
    },

    /**
     * Attempt to connect to a server.
     */
    connect: () => {
        connection.connect()
    },

    /**
     * Hook to be called when the client is shutting down.
     * @param {string} e 
     */
    onStop: (e) => {
        if (connection) {
            connection.disconnect(e)
        }
    },


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
    on: (eventName, handler) => {
        connection.on(eventName, handler)
    },

    /**
     * Unregisters an event handler for an event on this connection.
     * @param {string} eventName Name of the event ('connect', 'disconnect' & 'message').
     * @param {function} handler The function to remove
     */
    off: (eventName, handler) => {
        connection.off(eventName, handler)
    },

    messages: {
        state: (message, connection, core) => {

            let log = core.log

            switch(message.state) {
                case 'rejected': {
                    log(`The server rejected connection: ${message.reason}`)
                    return
                }
                case 'accepted': {
                    log(`The server accepted connection.`)
                    connection.send(JSON.stringify({
                        type: 'client.state',
                        state: 'ready'
                    }))
                    return
                }
            }
        }
    }
}