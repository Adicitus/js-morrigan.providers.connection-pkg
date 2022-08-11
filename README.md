# Morrigan Server: Connection Provider

Connections form the fundamental building block of Morrigan.

This provider authorizes & manages WebSocket connections for the system.

## Protocol status
**Current Version:** 0.1.1 (WIP, pre-release)

The protocol embodied by this provider is intended to provide a fundamental method of communication via WebSockets between 2 connecting clients in the system.

For this purpose, it manages 2 forms of resources:
- Connections: WebSocket connections allocated to connecting clients.
- Messages: JavaScript objects to send

### Connections
A connection is identified by UUID, and has 4 properties of note:
- clientAddress: A string representation of the remote IP-address of the connecting client.
- authenticated: Indicates whether the connecting client has been authenticated.
- isAlive: Indicates whether this connection is active.
- open: Indicates whether the connection endpoint is available for this connection.
- clientId: The ID of the connecting client (only appears if the connection is authenticated).
- serverId: The Id the of the responsible server (only appears if the connection is authenticated).

Messages can be sent to the connected client using the 'send' endpoint for the associated connection.

### Messages
JavaScript objects that are passed allong connections from one endpoint to another.

These objects will be stringified as JSON objects prior to transmission.

#### Format
Messages MUST have at least property called 'type', which will be used on the receiving end to identify the type of message and determine how the message should be handled.

In this way, different message types are intended to enable the development of communication protocols running over the infrastructure provided by the Connection protocol.

The formatting of the rest of the object is determined by the type of message.

### Process
When a connection attempt is made to the system, the following happens:

1. WebSocket connection is established to connection endpoint.
  - The connecting client's identity token is transmitted in the 'origin' header.
2. The Server verifies the identity token.
  - If the identity token cannot be verified, the connection attempt is aborted and the WebSocket connection is closed.
  - If the idenitty token is verifed, the server establishes the connection within the system:
    1. A record of the connection is committed to the datanase.
    2. An Interval is created to periodically ping the client over the WebSocket connection.
      - The client should respond to 'ping' WebSocket event with a 'pong' signal to demonstrate that it is alive.
    3. Message handling is configured on the WebSocket connection.
3. The server sends a 'connection.state' message to the client, with the 'state' property set to 'accepted'.