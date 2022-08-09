# Morrigan Server: Connection Provider

Connections form the fundamental building block of Morrigan.

This provider authorizes & manages WebSocket connections for the system.

## Protocol status
**Version:** 0.1.0 (pre-release)

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

### Messages
JavaScript objects that are passed allong connections from one endpoint to another.

These objects will be stringified as JSON objects prior to transmission.

#### Format
Messages are expected to have at least property called 'type', which will be used on the receiving end to identify the type of message and determine how the message should be handled.

In this way, different message types are intended to enable the development of communication protocols running over the infrastructure provided by the Connection protocol.

The formatting of the rest of the object is determined by the type of message.
