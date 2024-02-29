process.env.PROCESS_NAME = 'server';
import '../common/install-source-map-support';
import 'csdm/node/logger';
import type { RawData } from 'ws';
import type WebSocket from 'ws';
import { WebSocketServer as WSServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import { rendererHandlers } from 'csdm/server/handlers/renderer-handlers-mapping';
import type { RendererClientMessageName } from './renderer-client-message-name';
import { WEB_SOCKET_SERVER_PORT } from './port';
import type { SharedServerMessagePayload } from './shared-server-message-name';
import { SharedServerMessageName } from './shared-server-message-name';
import type { IdentifiableClientMessage } from './identifiable-client-message';
import { ErrorCode } from '../common/error-code';
import { NetworkError } from '../node/errors/network-error';
import type { RendererServerMessagePayload, RendererServerMessageName } from './renderer-server-message-name';
import type { Handler } from './handler';
import express from 'express';

process.on('uncaughtException', logger.error);
process.on('unhandledRejection', logger.error);

type SendableRendererMessagePayload<MessageName extends RendererServerMessageName> =
  RendererServerMessagePayload[MessageName];
type SendableRendererMessage<MessageName extends RendererServerMessageName = RendererServerMessageName> = {
  name: MessageName;
} & (SendableRendererMessagePayload<MessageName> extends void
  ? // eslint-disable-next-line @typescript-eslint/ban-types
    {}
  : {
      payload: SendableRendererMessagePayload<MessageName>;
    });

type SharedMessagePayload<MessageName extends SharedServerMessageName> = SharedServerMessagePayload[MessageName];
type SharedMessage<MessageName extends SharedServerMessageName = SharedServerMessageName> = {
  name: MessageName;
} & (SharedMessagePayload<MessageName> extends void
  ? // eslint-disable-next-line @typescript-eslint/ban-types
    {}
  : {
      payload: SharedMessagePayload<MessageName>;
    });

class WebSocketServer {
  public server: WSServer;
  private rendererProcessSocket: WebSocket | null = null;

  constructor() {
    this.server = new WSServer({
      noServer: true,
    });

    this.server.on('listening', this.onServerCreated);
    this.server.on('connection', this.onConnection);
    this.server.on('error', this.onError);
    this.server.on('close', this.onClose);
  }

  public sendMessageToRendererProcess = <MessageName extends RendererServerMessageName>(
    message: SendableRendererMessage<MessageName>,
  ): void => {
    if (this.rendererProcessSocket) {
      this.rendererProcessSocket.send(JSON.stringify(message));
    } else {
      logger.warn(`WS:: rendererProcessSocket is null, can't send message to renderer process`);
    }
  };

  public broadcast = <MessageName extends SharedServerMessageName>(message: SharedMessage<MessageName>): void => {
    for (const client of this.server.clients) {
      client.send(JSON.stringify(message));
    }
  };

  private onServerCreated = () => {
    logger.log(`WS:: server listening on port ${WEB_SOCKET_SERVER_PORT}`);
  };

  private onConnection = (webSocket: WebSocket, request: IncomingMessage): void => {
    if (request.url === undefined) {
      logger.error('WS:: Missing request URL');
      return;
    }

    logger.log(`WS:: renderer process socket connected`);
    this.rendererProcessSocket = webSocket;
    this.rendererProcessSocket.on('close', this.onRendererProcessSocketDisconnect);
    this.rendererProcessSocket.on('error', this.onRendererProcessSocketError);
    this.rendererProcessSocket.on('message', this.onRendererProcessSocketMessage);
  };

  private onRendererProcessSocketMessage = async (data: RawData): Promise<void> => {
    if (this.rendererProcessSocket === null) {
      logger.warn('WS:: renderer process socket not defined');
      return;
    }

    try {
      const message: IdentifiableClientMessage<RendererClientMessageName> = JSON.parse(data.toString());
      const { name, payload, uuid } = message;
      logger.log(`WS:: message with name ${name} and uuid ${uuid} received from renderer process`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler: Handler<any, any> = rendererHandlers[name];
      if (typeof handler === 'function') {
        try {
          const result = await handler(payload);
          this.sendMessageToRendererProcess({
            name: SharedServerMessageName.Reply,
            payload: result,
            uuid,
          } as SendableRendererMessage);
        } catch (error) {
          let payload: ErrorCode | string = ErrorCode.UnknownError;
          if (typeof error === 'string') {
            payload = error;
          } else if (typeof error === 'number') {
            payload = error as ErrorCode;
          }

          if (typeof payload === 'string' || payload === ErrorCode.UnknownError) {
            logger.error(`WS:: error handling message with ${name} from renderer process`);
            logger.error(error);
          }

          this.sendMessageToRendererProcess({
            name: SharedServerMessageName.ReplyError,
            payload,
            uuid,
          } as SendableRendererMessage);
        }
      } else {
        logger.warn(`WS:: unknown message name: ${name}`);
      }
    } catch (error) {
      logger.error('WS:: renderer process request error');
      logger.error(error);
    }
  };

  private onRendererProcessSocketDisconnect = (code: number, reason: string): void => {
    logger.log('WS:: renderer process socket disconnected', code, reason);
    this.rendererProcessSocket = null;
  };

  private onRendererProcessSocketError(error: unknown) {
    logger.error('WS:: renderer process socket error', error);
  }

  private onError = (error: Error) => {
    logger.error('WS:: an error occurred');
    logger.error(error);
  };

  private onClose = () => {
    logger.error('WS:: server closed');
  };
}

// In dev mode (when the WS server is started from the dev window), the DOM fetch API overrides the NodeJS fetch API.
// It allows to see requests in the DevTools only during development.
// ! Sometimes you may have to use explicitly undici (NodeJS fetch) because of differences between DOM/NodeJS APIs.
// ! In this case, you will not see requests from the DevTools.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    return await originalFetch(input, init);
  } catch (error) {
    // When a network issue occurred when calling fetch(), the error is a TypeError.
    // See fetch API spec: https://fetch.spec.whatwg.org/#fetch-api
    // > If response is a network error, then reject p with a TypeError and terminate these substeps.
    if (error instanceof TypeError) {
      logger.error(`Network error while calling ${input.toString()}`);
      logger.error(error);
      throw new NetworkError();
    }
    throw error;
  }
};

const wss = new WebSocketServer();

// Create express web server
const app = express();

// Host public static files
app.use(express.static('public'));

// Start the webserver
const server = app.listen(3000, () => {
  console.log('Express server listening on port 3000');
});

// Listen for websocket upgrade
server.on('upgrade', (request, socket, head) => {
  wss.server.handleUpgrade(request, socket, head, (ws) => {
    wss.server.emit('connection', ws, request);
  });
});
