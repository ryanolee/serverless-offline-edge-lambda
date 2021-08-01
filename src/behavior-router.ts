import { Context } from 'aws-lambda';
import bodyParser from 'body-parser';
import connect, { HandleFunction } from 'connect';
import cookieParser from 'cookie-parser';
import * as fs from 'fs-extra';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { StatusCodes } from 'http-status-codes';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { HttpError, InternalServerError } from './errors/http';

import { FunctionSet } from './function-set';
import { asyncMiddleware, cloudfrontPost } from './middlewares';
import { CloudFrontLifecycle, Origin, CacheService } from './services';
import { ServerlessInstance, ServerlessOptions } from './types';
import {
	buildConfig, buildContext, CloudFrontHeadersHelper, ConfigBuilder,
	convertToCloudFrontEvent, IncomingMessageWithBodyAndCookies
} from './utils';


interface OriginMapping {
	pathPattern: string;
	target: string;
	default?: boolean;
}

export class BehaviorRouter {
	private builder: ConfigBuilder;
	private context: Context;
	private behaviors = new Map<string, FunctionSet>();

	private cacheDir: string;
	private fileDir: string;
	private path: string;

	private origins: Map<string, Origin>;

	private cacheService: CacheService;
	private log: (message: string) => void;

	constructor(
		private serverless: ServerlessInstance,
		private options: ServerlessOptions
	) {
		this.log = serverless.cli.log.bind(serverless.cli);

		this.builder = buildConfig(serverless);
		this.context = buildContext();

		this.cacheDir = path.resolve(options.cacheDir || path.join(os.tmpdir(), 'edge-lambda'));
		this.fileDir = path.resolve(options.fileDir || path.join(os.tmpdir(), 'edge-lambda'));
		this.path = this.serverless.service.custom.offlineEdgeLambda.path || '';

		fs.mkdirpSync(this.cacheDir);
		fs.mkdirpSync(this.fileDir);

		this.origins = this.configureOrigins();
		this.cacheService = new CacheService(this.cacheDir);
	}

	match(req: IncomingMessage): FunctionSet | null {
		if (!req.url) {
			return null;
		}

		const url = new URL(req.url, 'http://localhost');

		for (const [, handler] of this.behaviors) {
			if (handler.regex.test(url.pathname)) {
				return handler;
			}
		}

		return this.behaviors.get('*') || null;
	}

	async listen(port: number) {
		try {
			await this.extractBehaviors();
			this.logStorage();
			this.logBehaviors();

			const app = connect();

			app.use(cloudfrontPost());
			app.use(bodyParser());
			app.use(cookieParser() as HandleFunction);
			app.use(asyncMiddleware(async (req: IncomingMessageWithBodyAndCookies, res: ServerResponse) => {
				if ((req.method || '').toUpperCase() === 'PURGE') {
					await this.purgeStorage();

					res.statusCode = StatusCodes.OK;
					res.end();
					return;
				}

				const handler = this.match(req);
				const cfEvent = convertToCloudFrontEvent(req, this.builder('viewer-request'));

				if (!handler) {
					res.statusCode = StatusCodes.NOT_FOUND;
					res.end();
					return;
				}

				try {
					const lifecycle = new CloudFrontLifecycle(this.serverless, this.options, cfEvent, this.context, this.cacheService, handler);
					const response = await lifecycle.run(req.url as string);

					if (!response) {
						throw new InternalServerError("No response set after full request lifecycle");
					}

					res.statusCode = parseInt(response.status, 10);
					res.statusMessage = response.statusDescription || '';

					const helper = new CloudFrontHeadersHelper(response.headers);

					for (const { key, value } of helper.asHttpHeaders()) {
						if (value) {
							res.setHeader(key as string, value);
						}
					}

					res.end(response.body);
				} catch (err) {
					this.handleError(err, res);
					return;
				}
			}));


			return new Promise(resolve => {
				const server = createServer(app);

				server.listen(port);
				server.on('close', resolve);
			});
		} catch (err) {
			console.error(err);
			process.exit(1);
		}
	}

	// Format errors
	public handleError(err: HttpError, res: ServerResponse) {
		res.statusCode = err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
		
		const payload = JSON.stringify(err.hasOwnProperty('getResponsePayload') ?
			err.getResponsePayload() :
			{
				code: StatusCodes.INTERNAL_SERVER_ERROR,
				message: err.stack || err.message 
			}
		)

		res.end(payload);
	}

	public async purgeStorage() {
		this.cacheService.purge();
	}

	private configureOrigins(): Map<string, Origin> {
		const { custom } = this.serverless.service;
		const mappings: OriginMapping[] = custom.offlineEdgeLambda.originMap || [];

		return mappings.reduce((acc, item) => {
			acc.set(item.pathPattern, new Origin(item.target));
			return acc;
		}, new Map<string, Origin>());
	}

	private async extractBehaviors() {
		const { functions } = this.serverless.service;

		const behaviors = this.behaviors;
		const lambdaDefs = Object.entries(functions)
			.filter(([, fn]) => 'lambdaAtEdge' in fn);

		behaviors.clear();

		for await (const [, def] of lambdaDefs) {
			const pattern = def.lambdaAtEdge.pathPattern || '*';

			if (!behaviors.has(pattern)) {
				const origin = this.origins.get(pattern);
				behaviors.set(pattern, new FunctionSet(pattern, this.log, origin));
			}

			const fnSet = behaviors.get(pattern) as FunctionSet;

			await fnSet.setHandler(def.lambdaAtEdge.eventType, path.join(this.path, def.handler));
		}

		if (!behaviors.has('*')) {
			behaviors.set('*', new FunctionSet('*', this.log, this.origins.get('*')));
		}
	}

	private logStorage() {
		this.log(`Cache directory: file://${this.cacheDir}`);
		this.log(`Files directory: file://${this.fileDir}`);
		console.log();
	}

	private logBehaviors() {
		this.behaviors.forEach((behavior, key) => {
			this.log(`Lambdas for path pattern ${key}: `);

			behavior.viewerRequest && this.log(`viewer-request => ${behavior.viewerRequest.path || ''}`);
			behavior.originRequest && this.log(`origin-request => ${behavior.originRequest.path || ''}`);
			behavior.originResponse && this.log(`origin-response => ${behavior.originResponse.path || ''}`);
			behavior.viewerResponse && this.log(`viewer-response => ${behavior.viewerResponse.path || ''}`);

			console.log(); // New line
		});
	}
}
