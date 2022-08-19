# Morrigan Server: Connection Provider

Connections form the fundamental building block of Morrigan.

This provider authorizes & manages WebSocket connections for the system.

## Protocol status
**Current Version:** 0.2.0 (WIP, pre-release)

The protocol embodied by this provider is intended to provide a fundamental method of communication via WebSockets between 2 connecting clients in the system.

For this purpose, it manages 2 forms of resources:
- Endpoints: HTTP endpoints to request connection authorization token and establish WebSocket connection.
- Connections: WebSocket connections allocated to connecting clients.
- Messages: JavaScript objects sent across a connection.

## Components

### Endpoints
There are 2 endpoints of note in this version of the protocol: 
- /: The root endpoint for this provider. THis endpoint is used by clients to requisition a new connection authorization token, and by users to retrieve information about exisiting connections.
- /connect: WebSocket connection endpoint.
  - In future versions of this protocol, each connection should have it's own WebSocket connection endpoint under this route which can be opened and closed as needed.

### Connections
By "Connnection" in this document we generally mean WebSocket connections used by a client to interact with the system.

A connection is identified by UUID, and tracked using records on the server side.

A connection record may have any of the following properties:
- Id: ID of this connection.
- clientId: ID of the client using this connection. This will only be available once a connection has been established.
- serverId: The Id the of the responsible server. This will only be available if the connection has been successfully established by a client.
- tokenId: The ID of the token used associated with this connection.
- clientAddress: A string representation of the remote IP-address of the connecting client. This will only be available once a client has connected successfully.
- connected: Indicates whether the connecting client has been authenticated. This will be false until a client connects successfully, at which point this will be the ISO 8601 DateTime when the connection was established.
- alive: Indicates whether this connection is active (has responded to ping in the last 30 seconds).
- open: Indicates whether the connection endpoint is available for this connection.
- lastHearbeat: ISO 8601 DateTime string indicating the last time the client using this connection responded to a ping attempt. This is only available once a connection has been successfully established.
- disconnected: ISO 8601 DateTime string indicating when the connection was closed. This is only available once a connection has been successfully established and then disconnected.
- reportUrl: The URL to which the client should connect when establishing the WebSocket connection.

Messages can be sent to the connected client using the 'send' endpoint for the associated connection.

#### Provisioning & Connection

In order to establish a connection, a client must first be provisioned to retrieve it's identity token. The identity token can then be used to provision a WebSocket connection token by submitting to the connection authorization endpoint.

The connection token is a short lifespan (60 seconds) token which contains the report URL (reportUrl) to which the client should connect.

The connection token is then used to to authenticate the WebSocket connection by passing it in the 'origin' header.

### Messages
JavaScript objects that are passed along connections from one endpoint to another.

These objects will be stringified as JSON objects prior to transmission.

#### Format
Messages MUST have at least property called 'type', which will be used on the receiving end to identify the type of message and determine how the message should be handled.

In this way, different message types are intended to enable the development of communication protocols running over the infrastructure provided by the Connection protocol.

The formatting of the rest of the object is determined by the type of message.

## Process
When a connection attempt is made to the system, the following happens:

1. The client initiates a HTTP POST request with it's identity token (in the 'authorization header'), the server responds with an authorization token which contains a report URL. 
2. WebSocket connection is established to the report URL.
  - The authorization token is included in the 'origin' header.
3. The Server verifies the authorization token.
  - If the token cannot be verified, the connection attempt is aborted and the WebSocket connection is closed.
  - If the token is verifed, the connection is marked as 'connected'
    1. An Interval is created to periodically ping the client over the WebSocket connection.
      - The client should respond to 'ping' WebSocket event with a 'pong' signal to demonstrate that it is alive.
    2. Message handling is configured on the WebSocket connection.
4. The server sends a 'connection.state' message to the client, with the 'state' property set to 'accepted'.