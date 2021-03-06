const {fs, path, logger} = require('../src/util');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const url = require('url');

const transpiler = require('../src/transpiler');

module.exports = function (config) {
    const options = require('../src/configure')(config);

    const app = express();

    app.use(cors());
    app.use(multer({storage: multer.memoryStorage()}).any());

    app.use(function (req, res, next) {
        req.time = Date.now();
        req.nocache = req.headers['pragma'] === 'no-cache';
        req.lastModified = new Date(req.headers['last-modified']);
        req.rawquery = url.parse(req.originalUrl).query;

        if (req.rawquery && !Number.isNaN(req.rawquery)) {
            req.lastModified = new Date(Number.parseInt(req.rawquery));
        }
        if (Number.isNaN(req.lastModified.getTime())) {
            req.lastModified = new Date();
        }

        logger.debug({
            nocache: req.nocache,
            lastModified: req.lastModified,
            rawquery: req.rawquery,
        });

        const method = req.method;
        res.on('finish', function () {
            const message = `${method} ${req.originalUrl} ${res.statusCode} ${Date.now() - req.time}ms`;
            if (res.statusCode < 400) {
                logger.info(message);
            }
            else if (res.statusCode < 500) {
                logger.warn(message);
            }
            else {
                logger.error(message);
            }
        });

        next();
    });

    if (options.maps instanceof Object && !(options.maps instanceof String)) {
        for (const [relative, absolute] of Object.entries(options.maps)) {
            app.use(relative, express.static(absolute));
        }
    }

    for (const [local, rootdir] of Object.entries(options.routes)) {
        const router = express.Router();
        router.get('/*', function (req, res, next) {
            return async function () {
                const reqfile = path.join(rootdir, req.path);
                const altfiles = [];
                for (const file of path.separateName(',', reqfile)) {
                    const altfile = transpiler.getAltfile(file, reqfile !== file);
                    if (altfile) {
                        altfiles.push(altfile);
                    }
                }
                if (altfiles.length) {
                    await transpiler.transpile(altfiles, Object.assign({}, options, {
                        rootdir: rootdir,
                        localdir: local,
                        outfile: reqfile,
                        nocache: req.nocache,
                    }));
                }

                // fall through static middleware
                return next();
            }().catch(next);
        });

        router.post('/*', function (req, res, next) {
            return async function () {
                const reqfile = path.join(rootdir, req.path);
                const altfiles = [];

                let alt = false;
                for (const file of req.files) {
                    const altfile = path.join(options.tmpdir, 'assetter', 'uploaded', req.path, file.originalname);
                    altfiles.push(altfile);
                    if (req.nocache || (await fs.promises.mtime(reqfile) < req.lastModified) || !fs.existsSync(altfile)) {
                        await fs.promises.putFile(altfile, file.buffer.toString());
                        alt = true;
                    }
                }
                if (alt) {
                    await transpiler.transpile(altfiles, Object.assign({}, options, {
                        rootdir: rootdir,
                        localdir: local,
                        outfile: reqfile,
                        nocache: req.nocache,
                    }));
                }

                // fall through static middleware
                req.method = 'GET';
                return next();
            }().catch(next);
        });

        router.use(express.static(rootdir));

        app.use(local, router);
    }

    app.use(function (err, req, res, next) {
        logger.error(err);
        res.set('content-type', 'text/plain');
        res.status(500).send(err + '\n\n' + JSON.stringify(err, null, "\t"));
    });

    app.listen(options.port, options.host, function () {
        logger.info(`[HTTP] ${options.host}:${options.port}`);
    });
};
