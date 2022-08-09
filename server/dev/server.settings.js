module.exports = {

    /*
        Directory where the state information for this server should be stored.
        If not specified defaults to `/morrigan.server/state`.
    */
    stateDir: "/morrigan.server/dev/state",

    
    /**
     * HTTP settings.
     * 
     * Currently recognizes the following options:
     * - port: The port number that the server should listen on.
     * - secure: A boolean to indicate whether the server should use HTTPS.
     * - certPath: Iff secure is true, this key specifies a location where the server can expect to to find the x509 certificate for the server.
     * - keyPath: Iff secure is true, this key specifies the location where the server can expect to find the private key corresponding to the certificate.
     * 
     * This key is not required and can be safely omitted. This will create a HTTP server that listens on port 3000.
     */
    http: {
        port: 8080
    },

    /**
     * MongoDB connection details.
     * 
     * Accepts the following options:
     * - connectionString: A connection string used to establish connection to the MongoDB server.
     * - dbname: The name the database to use.
     * 
     * This setting is required and has no defaults.
     */
    database: {
        connectionString: "mongodb://127.0.0.1:27017",
        dbname: "morrigan-server"
    },

    /**
     * settings for the built-in logger module.
     * 
     * Accepts the following options:
     * - console: boolean to determine where if the logged messages should also be printed to the console (default: true).
     * - logDir: The directory on the local machine where log files should be written (default: '/morrigan.server/logs').
     * - level: The level of messages to log (see: https://www.npmjs.com/package/winston#logging-levels).
     * 
     * None of these options are mandatory.
     * 
     */
    logger: {
        console: true,
        logDir: "/morrigan.server/dev/logs",
        level: 'debug'
    },

    /**
     * Components specifications.
     * 
     * Each key in the component specifications object should contain a component specification, consisting of the following keys:
     * - module: Name of a module to load. This key is required (any component without it will be skipped).
     * - providers: An array of names for modules that the component should use as providers.
     *   This key is not required, but is used by both built-in components to specify what functionality to provide.
     * 
     * This setting can be omitted, but this will result in a server without any functionality.
     */
    components: {
        core: {
            module: '@adicitus/morrigan.components.core',

            providers: [
                { module: require('../server') },
                '@adicitus/morrigan.server.providers.client',
                '@adicitus/morrigan.server.providers.capability'
            ]
        },

        auth: {
            module: '@adicitus/morrigan.components.authentication',

            providers: [
                '@adicitus/morrigan.authentication.password'
            ]
        }
    }
}