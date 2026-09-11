## ADDED Requirements

### Requirement: Default loopback-only binding
The server SHALL bind to a loopback-only address unless an explicit LAN access flag is set. When the flag is not set, the server SHALL NOT accept connections from any non-loopback network interface.

#### Scenario: Server starts without the LAN access flag
- **WHEN** the server starts with no LAN access flag configured
- **THEN** the server is reachable only from loopback addresses, and connection attempts from another host on the same network cannot establish a connection

#### Scenario: Server starts with the LAN access flag set
- **WHEN** the server starts with the LAN access flag explicitly enabled
- **THEN** the server is reachable on all network interfaces

### Requirement: Uniform authentication across connection types under LAN access
When the LAN access flag is enabled, HTTP, Server-Sent Events (SSE), and WebSocket connection paths SHALL enforce the identical authentication requirement for non-loopback callers. No connection type SHALL be permitted to bypass authentication that another connection type enforces.

#### Scenario: Unauthenticated HTTP request from a LAN client
- **WHEN** the LAN access flag is enabled and a non-loopback client sends an HTTP request without valid authentication
- **THEN** the request is rejected before it reaches application logic

#### Scenario: Unauthenticated SSE subscription from a LAN client
- **WHEN** the LAN access flag is enabled and a non-loopback client attempts to open an SSE subscription without valid authentication
- **THEN** the connection is closed at handshake and no event stream is established

#### Scenario: Unauthenticated WebSocket upgrade from a LAN client
- **WHEN** the LAN access flag is enabled and a non-loopback client attempts a WebSocket upgrade without valid authentication
- **THEN** the upgrade is rejected and no WebSocket connection is established

#### Scenario: Authenticated LAN client across all three connection types
- **WHEN** the LAN access flag is enabled and a non-loopback client presents valid authentication
- **THEN** HTTP requests, SSE subscriptions, and WebSocket upgrades from that client all succeed

##### Example: consistent rejection across connection types

| Connection type | Authenticated | Outcome |
| --- | --- | --- |
| HTTP | no | rejected before application logic |
| SSE | no | connection closed at handshake |
| WebSocket | no | upgrade rejected |
| HTTP | yes | request proceeds |
| SSE | yes | event stream established |
| WebSocket | yes | connection established |

### Requirement: Actor identity headers trusted only from loopback callers
The system SHALL trust caller-supplied actor identity headers (`X-Taskboard-User-*`) only when the request originates from a loopback address. When such headers are present on a request from a non-loopback address, the system SHALL ignore them and SHALL resolve the actor to the default anonymous local-user identity.

#### Scenario: Actor headers from a loopback caller
- **WHEN** a request from a loopback address includes valid `X-Taskboard-User-*` headers
- **THEN** the actor identity is resolved from those headers

#### Scenario: Actor headers from an authenticated LAN caller
- **WHEN** a request from a non-loopback address that has passed LAN authentication includes `X-Taskboard-User-*` headers
- **THEN** the headers are ignored and the actor identity resolves to the default anonymous local-user identity

### Requirement: Machine-level metadata and capability routes remain loopback-only unconditionally
Machine-level metadata routes and capability routes SHALL reject requests from any non-loopback address, regardless of whether the LAN access flag is enabled and regardless of whether the caller has passed LAN authentication.

#### Scenario: Authenticated LAN client requests a machine-level metadata route
- **WHEN** the LAN access flag is enabled and a non-loopback client that has passed LAN authentication requests a machine-level metadata or capability route
- **THEN** the request is rejected

#### Scenario: Loopback client requests a machine-level metadata route
- **WHEN** a loopback client requests a machine-level metadata or capability route
- **THEN** the request is served normally
