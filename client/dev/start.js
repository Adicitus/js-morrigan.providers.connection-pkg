let MorriganClient = require('@adicitus/morrigan.client')
let settings = require('./client.settings')
let log = console.log

let client = require('@adicitus/morrigan.client')(settings, log)

client.connect()