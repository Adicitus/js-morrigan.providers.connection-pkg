module.exports = {

    // The path to the state directory. If this option is not specified,
    // the state directory will be created under the morrigan client directory.
    stateDir: "/morrigan.client/state",

    providers: [
        "@adicitus/morrigan.client.providers.client",
        require('../client'),
        "@adicitus/morrigan.client.providers.capability"
    ],

    // The URL that the client should connect to:
    reportURL: "http://localhost:8080/api/core/connection",
    token: "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZkMjFlMWMwLWJkODUtNGE1Zi05NjAzLWMyM2FkYjRlMzQyNCJ9.eyJzdWIiOiI5ZjM5ZWEwYy02MTBiLTQ5NGUtYTJmMS02NWZhYTViNzVkYzYiLCJpc3MiOiI5ZWJiNjM5Yy0zODFjLTRmOTctYjlhZS0zYWQxOTgwNzFiMjAiLCJpYXQiOjE2NjA2MjE1ODUsImV4cCI6MTY2MzIxMzU4NX0.AAAAABJ84kaeiJvaZXjoANcVgDYUryYh6_IolhBQfRoAAAAAK9p2Uf68U1FxhuwUCBjK1qZH-EvKT5G2lcuVdA"
}