import process from 'node:process';
import { Worker } from 'node:worker_threads';
import uWS from '../uWebSockets.js/uws.js';

const PORT = process.env.PORT ?? 32456;

function readJSON(res, cb) {
  let buffer;

  res.onData((ab, isLast) => {
    let chunk = Buffer.from(ab);

    if (isLast) {
      let json;

      if (buffer) {
        try {
          json = JSON.parse(Buffer.concat([buffer, chunk]).toString());
        } catch (e) {
          console.error(e);
          res.close();

          return;
        }

        cb(json);
      } else {
        try {
          json = JSON.parse(chunk.toString());
        } catch (e) {
          console.error(e);
          res.close();

          return;
        }

        cb(json);
      }
    } else if (buffer) {
      buffer = Buffer.concat([buffer, chunk]);
    } else {
      buffer = Buffer.concat([chunk]);
    }
  });

  res.onAborted(() => {
    console.error('Invalid JSON or no data.');
  });
}

function cors(res) {
  if (res) {
    res
      .writeHeader('Access-Control-Allow-Origin', '*')
      .writeHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS, PUT, PATCH, DELETE'
      )
      .writeHeader('Access-Control-Allow-Headers', 'content-type');
  }

  return res;
}

async function later(delay) {
  return new Promise(function (resolve) {
    setTimeout(resolve, delay);
  });
}

export default class Aspirant {
  #id;

  #respawnTimeout;

  #redisCommand;

  #workers = new Map();

  constructor({
    id,
    serviceMachineUrl,
    host,
    port,
    tls,
    username,
    database,
    password,
    respawnTimeout = 1000
  }) {
    globalThis.Aspirant = this;

    this.#respawnTimeout = respawnTimeout;
    this.#id = id;
    this.#redisCommand = async (command) =>
      fetch(new URL('redis', serviceMachineUrl).toString(), {
        method: 'POST',
        cache: 'no-cache',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          socket: {
            host,
            port,
            tls
          },
          username,
          database,
          password,
          command
        })
      });
  }

  get key() {
    return `ppp-aspirant:${this.#id}:workers`;
  }

  async #sync() {
    try {
      // Can fail if service machine is not OK
      const map = await (
        await this.#redisCommand(['HGETALL', this.key])
      ).json();
      let i = 0;

      for (const _id of map) {
        if (i % 2 === 0) {
          const { source, env } = JSON.parse(map[i + 1]);

          await this.#runWorker(_id, { source, env });
        }

        i++;
      }
    } catch (e) {
      console.error(e);
      setTimeout(() => this.#sync(), 1000);
    }
  }

  #onWorkerExit() {
    for (const v of globalThis.Aspirant.#workers.values()) {
      if (v.worker === this) {
        v.worker.timer = setTimeout(() => {
          if (globalThis.Aspirant.#workers.has(v._id))
            void globalThis.Aspirant.#runWorker(v._id, {
              source: v.source,
              env: v.env
            });
        }, globalThis.Aspirant.#respawnTimeout);

        break;
      }
    }
  }

  async #runWorker(_id, { source, env = {} }) {
    try {
      if (this.#workers.has(_id)) {
        const currentWorkerData = this.#workers.get(_id);

        clearTimeout(currentWorkerData.worker.timer);

        await currentWorkerData.worker.terminate();
        currentWorkerData.worker.unref();
        currentWorkerData.worker.off('exit', this.#onWorkerExit);
        this.#workers.delete(_id);
      }

      this.#workers.set(_id, {
        _id,
        source,
        env,
        worker: new Worker(new URL(`data:text/javascript,${source}`), {
          env: Object.assign({}, process.env, env),
          workerData: {
            aspirant: this
          }
        })
      });

      this.#workers.get(_id).worker.on('exit', this.#onWorkerExit);
    } catch (e) {
      console.error(e);

      setTimeout(() => {
        this.#runWorker(_id, { source, env });
      }, this.#respawnTimeout);
    }
  }

  async main() {
    uWS
      .App({})
      .get('/workers', async (res) => {
        res
          .writeHeader('Content-Type', 'application/json;charset=UTF-8')
          .end(JSON.stringify(Object.fromEntries(this.#workers)));
      })
      .options('/*', (res) => {
        return cors(res).writeStatus('200 OK').end();
      })
      .post('/workers', async (res) => {
        readJSON(res, async (payload = {}) => {
          try {
            const { _id, source, env = {} } = payload;

            if (!_id)
              return cors(res)
                .writeStatus('400 Bad Request')
                .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
                .end('Missing worker _id.');

            if (!source)
              return cors(res)
                .writeStatus('400 Bad Request')
                .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
                .end('Missing worker source.');

            await this.#redisCommand([
              'HSET',
              this.key,
              _id,
              JSON.stringify({ source, env })
            ]);

            await this.#runWorker(_id, {
              source,
              env
            });

            cors(res)
              .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
              .end('200 OK');
          } catch (e) {
            console.error(e);

            cors(res)
              .writeStatus('500 Internal Server Error')
              .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
              .end('500 Internal Server Error');
          }
        });
      })
      .del('/workers', async (res) => {
        readJSON(res, async (payload = {}) => {
          try {
            const { _id } = payload;

            if (!_id)
              return cors(res)
                .writeStatus('400 Bad Request')
                .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
                .end('Missing worker _id.');

            await this.#redisCommand(['HDEL', this.key, _id]);

            if (this.#workers.has(_id)) {
              const currentWorkerData = this.#workers.get(_id);

              clearTimeout(currentWorkerData.worker.timer);

              this.#workers.delete(_id);
              currentWorkerData.worker.off('exit', this.#onWorkerExit);
              await currentWorkerData.worker.terminate();
              currentWorkerData.worker.unref();
            }

            cors(res)
              .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
              .end('200 OK');
          } catch (e) {
            console.error(e);

            cors(res)
              .writeStatus('500 Internal Server Error')
              .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
              .end('500 Internal Server Error');
          }
        });
      })
      .get('/ping_redis', async (res) => {
        res.onAborted(() => {
          console.error(res);
        });

        try {
          cors(res)
            .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
            .end(await (await this.#redisCommand(['PING'])).text());
        } catch (e) {
          console.error(e);

          cors(res)
            .writeStatus('500 Internal Server Error')
            .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
            .end('500 Internal Server Error');
        }
      })
      .get('/ping', async (res) => {
        cors(res)
          .writeHeader('Content-Type', 'text/plain;charset=UTF-8')
          .end('pong');
      })
      .listen(PORT, async (listenSocket) => {
        if (listenSocket) {
          console.log(`Listening to port ${PORT}`);
        }
      });

    await this.#sync();
  }
}

if (!process.env.ASPIRANT_ID) console.error('Aspirant ID must be provided.');
else if (!process.env.SERVICE_MACHINE_URL)
  console.error('Missing service machine URL.');
else {
  await new Aspirant({
    id: process.env.ASPIRANT_ID,
    serviceMachineUrl: process.env.SERVICE_MACHINE_URL,
    host: process.env.REDIS_HOST,
    port: +process.env.REDIS_PORT,
    tls: !!process.env.REDIS_TLS,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    database: +process.env.REDIS_DATABASE,
    respawnTimeout: +process.env.RESPAWN_TIMEOUT || 1000
  }).main();
}
