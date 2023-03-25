const WebSocket = require('ws');

const WebSocketAddress = 'wss://api.abinteractive.net/1/users/ws';

const log = require('./logger').GetLogger('API_WS');

const events = require('events');
const utils = require('./utils');

// // Test websocket server start
// if (process.env.TEST_WS_SERVER === 'true' && !require('electron').app.isPackaged) {
//     log.warn('Initializing testing websocket server...');
//     require('./ws_fake.test');
//     log.warn('Setting websocket url to localhost...');
//     WebSocketAddress = 'ws://localhost';
// }

const EventEmitter = new events.EventEmitter();
exports.EventEmitter = EventEmitter;

const MaxReconnectionAttempts = 5;

let currentUsername;
let currentAccessKey;

let previousSocket;

const SOCKET_EVENTS = Object.freeze({
    CONNECTED: Symbol(),
    DEAD: Symbol(),
    RECONNECTION_FAILED: Symbol(),
});
exports.SocketEvents = SOCKET_EVENTS;

const RESPONSE_TYPE = Object.freeze({
    MENU_POPUP: 0,
    HUD_MESSAGE: 1,
    ONLINE_FRIENDS: 10,
    INVITES: 15,
    REQUEST_INVITES: 20,
    FRIEND_REQUESTS: 25,
});
exports.ResponseType = RESPONSE_TYPE;
const GetResponseTypeName = (value) => Object.keys(RESPONSE_TYPE).find(key => RESPONSE_TYPE[key] === value);


const heartbeatInterval = 60 * 1000;
const missedPongsTimeout = 5;
let heartbeatTimeout;
function heartbeat(socket) {
    // The server will send a pong every 60 seconds, if there's no pong within 5 minutes let's nuke the socket
    clearTimeout(heartbeatTimeout);
    heartbeatTimeout = setTimeout(async () => {
        log.warn(`[Heartbeat] {${socket.uniqueId}} timed out... Destroying socket!`);
        exports.DisconnectWebsocket();
    }, missedPongsTimeout * heartbeatInterval);
}


function Wait5Seconds() {
    return new Promise((resolve) => {
        setTimeout(resolve, 5000);
    });
}


exports.ConnectWithCredentials = async (username, accessKey) => {

    // If we have a socket connected and the credentials changed, lets nuke it
    if ((username !== currentUsername || accessKey !== currentAccessKey) && previousSocket) {
        await exports.DisconnectWebsocket();
    }

    // Clear previous connection stuff
    clearTimeout(reconnectTimeoutId);
    clearTimeout(heartbeatTimeout);
    reconnectCounter = 0;

    currentUsername = username;
    currentAccessKey = accessKey;

    await ConnectWebsocket(username, accessKey);
};


let reconnectCounter = 0;
let reconnectTimeoutId;
exports.Reconnect = async (manualRetry = false) => {

    if (previousSocket && (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING)) {
        const msg = 'The socket is already connected or connecting...';
        if (manualRetry) EventEmitter.emit(SOCKET_EVENTS.RECONNECTION_FAILED, msg);
        return;
    }

    if (!currentUsername || !currentAccessKey) {
        const msg = 'Missing current credentials... Close the CVRX and try again.';
        if (manualRetry) EventEmitter.emit(SOCKET_EVENTS.RECONNECTION_FAILED, msg);
        return;
    }

    if (manualRetry) {
        reconnectCounter = 0;
    }

    reconnectCounter += 1;
    if (reconnectCounter > MaxReconnectionAttempts) {
        log.error(`[Reconnect] Failed to connect to CVR Websocket, attempted ${reconnectCounter - 1}/${MaxReconnectionAttempts} times! Giving up...`);
        EventEmitter.emit(SOCKET_EVENTS.DEAD);
        return;
    }
    else {
        log.warn(`[Reconnect] Attempting to connect to CVR Websocket, attempt: ${reconnectCounter}/${MaxReconnectionAttempts}`);
    }

    // If the last reconnection was 2 minutes ago, reset the reconnection counter
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = setTimeout(() => {
        reconnectCounter = 0;
    }, 2 * 60 * 1000);

    try {
        await ConnectWebsocket(currentUsername, currentAccessKey);
    }
    catch (e) {
        log.error('[Reconnect] Error connecting to the Websocket...', e.toString(), e.message.toString());
        EventEmitter.emit(SOCKET_EVENTS.DEAD);
    }
};


exports.DisconnectWebsocket = () => {
    if (previousSocket) {
        previousSocket.close();
        previousSocket.terminate();
        log.info(`[DisconnectWebsocket] {${previousSocket.uniqueId}} The socket has been closed and destroyed!`);
    }
};


let socketIdGenerator = 0;
function ConnectWebsocket(username, accessKey) {

    return new Promise((resolve, _reject) => {

        if (previousSocket) {
            if (previousSocket.readyState === WebSocket.OPEN || previousSocket.readyState === WebSocket.CONNECTING) {
                log.error(`[ConnectWebsocket] {${previousSocket.uniqueId}} The previous socket is still connected/connecting. readyState: ${previousSocket.readyState}`);
                resolve();
                return;
            }
            if (previousSocket.readyState === WebSocket.CLOSING || previousSocket.readyState === WebSocket.CLOSED) {
                log.warn(`[ConnectWebsocket] {${previousSocket.uniqueId}} There was a previous socket, but it was closed/closing. readyState: ${previousSocket.readyState}`);
            }
        }

        const socket = new WebSocket(WebSocketAddress, {
            perMessageDeflate: false,
            headers: {
                'Username': username,
                'AccessKey': accessKey,
                'User-Agent': utils.GetUserAgent(),
            },
        });

        socket.uniqueId = socketIdGenerator++;
        previousSocket = socket;

        socket.on('error', async (error) => {
            log.error(`[ConnectWebsocket] [onError] {${socket.uniqueId}}`, error);
        });

        socket.on('open', () => {
            log.info(`[ConnectWebsocket] [onOpen] {${socket.uniqueId}} Opened!`);
            EventEmitter.emit(SOCKET_EVENTS.CONNECTED);
            heartbeat(socket);
            resolve();
        });

        socket.on('ping', (data) => {
            log.verbose(`[ConnectWebsocket] [onPing] {${socket.uniqueId}} Received Ping`, data.toString());
        });
        socket.on('pong', (data) => {
            heartbeat(socket);
            log.verbose(`[ConnectWebsocket] [onPong] {${socket.uniqueId}} Received Pong`, data.toString());
        });
        socket.on('redirect', (url, _request) => {
            log.verbose(`[ConnectWebsocket] [onRedirect] {${socket.uniqueId}} Received Redirect Request: ${url}`);
        });
        socket.on('unexpected-response', (request, response) => {
            log.debug(`[ConnectWebsocket] [onUnexpectedResponse] {${socket.uniqueId}} Unexpected Response! Request Code: ${request.code}, Response Code: ${response.code}`);
        });
        socket.on('upgrade', (response) => {
            log.verbose(`[ConnectWebsocket] [onUpgrade] {${socket.uniqueId}} Upgrade: Response Code: ${response.code}`);
        });

        socket.on('close', async (code, reason) => {
            log.warn(`[ConnectWebsocket] [onClose] {${socket.uniqueId}} Closed! Code: ${code}, Reason: ${reason.toString()}`);
            previousSocket = null;
            // Only attempt to reconnect if the close code is one of the following:
            if (code === 1001 || code === 1005 || code === 1006) {
                log.info('[ConnectWebsocket] [onClose] Attempting to reconnect in 5 seconds...');
                await Wait5Seconds();
                await exports.Reconnect();
            }
        });

        socket.on('message', (messageBuffer, isBinary) => {

            // Ignore binary messages, but log them
            if (isBinary) {
                log.warn(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Received Message in binary...`, messageBuffer?.toString());
                return;
            }

            // Attempt to parse json
            try {
                const { responseType, message, data } = JSON.parse(messageBuffer.toString());
                if (Object.values(RESPONSE_TYPE).includes(responseType)) {
                    EventEmitter.emit(responseType, data, message);
                    log.debug(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Type: ${GetResponseTypeName(responseType)} (${responseType}), Msg: ${message}`, data);
                }
                else {
                    log.warn(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Response type ${responseType} is not mapped! Msg: ${message}`, data);
                }
            } catch (e) {
                log.error(e);
                log.error(`[ConnectWebsocket] [onMessage] {${socket.uniqueId}} Failed to parse the base message. This could mean the API changed...`, messageBuffer?.toString());
            }
        });
    });
}

const RequestType = Object.freeze({
    FRIEND_REQUEST_SEND: 5,
    FRIEND_REQUEST_ACCEPT: 6,
    FRIEND_REQUEST_DECLINE: 7,
    UNFRIEND: 8,
    BLOCK_USER: 30,
    UNBLOCK_USER: 31,
});
const GetRequestName = (value) => Object.keys(RequestType).find(key => RequestType[key] === value);

function SendRequest(requestType, data) {
    if (!previousSocket || previousSocket.readyState !== WebSocket.OPEN) {
        log.error(`[SendRequest] Attempted to send a ${GetRequestName(requestType)} request while the socket was not Opened! readyState: ${previousSocket.readyState}`);
        return;
    }
    // Prepare the request json and send
    previousSocket.send(JSON.stringify({
        RequestType: requestType,
        Data: data,
    }));
}

// Friendship
exports.SendFriendRequest = async (userId) => SendRequest(RequestType.FRIEND_REQUEST_SEND, {id: userId});
exports.AcceptFriendRequest = async (userId) => SendRequest(RequestType.FRIEND_REQUEST_ACCEPT, {id: userId});
exports.DeclineFriendRequest = async (userId) => SendRequest(RequestType.FRIEND_REQUEST_DECLINE, {id: userId});
exports.Unfriend = async (userId) => SendRequest(RequestType.UNFRIEND, {id: userId});

// Moderation
exports.BlockUser = async (userId) => SendRequest(RequestType.BLOCK_USER, {id: userId});
exports.UnblockUser = async (userId) => SendRequest(RequestType.UNBLOCK_USER, {id: userId});
