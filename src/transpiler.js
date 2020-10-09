const {fs, path} = require('./util');
const util = require('util');
const minimatch = require('minimatch');

const compilers = new function () {
    this['.css'] = this['.sass'] = this['.scss'] = {
        ext: '.css',
        mappingURL: url => `\n/*# sourceMappingURL=${url} */`,
        compile: async function (input, options) {
            const postcss = function (css) {
                const postcss = require('postcss');
                const autoprefixer = require('autoprefixer');
                const opt = {
                    grid: "autoplace",
                    overrideBrowserslist: options.browserslist,
                };
                return postcss([autoprefixer(opt)]).process(css, {}).css;
            };
            // https://github.com/sass/node-sass
            const nodeSass = require('node-sass');
            this.promise = this.promise || util.promisify(nodeSass.render);
            return this.promise({
                outputStyle: options.minified ? 'compressed' : 'expanded',
                file: input,
                // https://qiita.com/http_kato83/items/c62ee3d255f45fc30c3b
                data: (await fs.promises.readFile(input)).toString(),
                sourceMap: 'dummy',
                omitSourceMapUrl: true,
                sourceMapContents: true,
            }).then(result => ({
                content: postcss(result.css.toString()),
                mapping: JSON.parse(result.map.toString()),
            }));
        },
        callback: null,
    };

    this['.styl'] = this['.stylus'] = {
        ext: '.css',
        mappingURL: url => `\n/*# sourceMappingURL=${url} */`,
        compile: async function (input, options) {
            const postcss = function (css) {
                const postcss = require('postcss');
                const autoprefixer = require('autoprefixer');
                const opt = {
                    grid: "autoplace",
                    overrideBrowserslist: options.browserslist,
                };
                return postcss([autoprefixer(opt)]).process(css, {}).css;
            };
            // https://stylus-lang.com/docs/executable.html
            const content = (await fs.promises.readFile(input)).toString();
            const renderer = require('stylus')(content, {
                filename: input,
                compress: options.minified,
                sourcemap: {comment: false},
            });
            return Promise.resolve({
                content: postcss(renderer.render()),
                mapping: Object.assign(renderer.sourcemap, {
                    sourcesContent: [content],
                }),
            })
        },
        callback: null,
    };

    this['.js'] = this['.es'] = this['.es6'] = {
        ext: '.js',
        mappingURL: url => `\n//# sourceMappingURL=${url}`,
        compile: async function (input, options) {
            // https://babeljs.io/docs/en/options
            const babel = require('@babel/core');
            return babel.transformAsync((await fs.promises.readFile(input)).toString(), {
                ast: false,
                babelrc: false,
                presets: [["@babel/env", {
                    modules: false,
                    targets: options.browserslist,
                }]],
                plugins: [
                    {
                        name: 'babel-prefix-plugin',
                        visitor: {
                            Program: {
                                enter: function (path, file) {
                                    path.unshiftContainer('body', babel.template(' "use transpile";')());
                                }
                            }
                        }
                    }
                ],
                inputSourceMap: false,
                sourceMaps: true,
                comments: false,
                compact: options.minified,
                retainLines: !options.minified,
                highlightCode: false,
            }).then(result => ({
                content: result.code,
                mapping: result.map,
            }));
        },
        callback: null,
    };
};

module.exports.regsiter = function (altext, compiler, similar = null) {
    if (typeof (compiler) === 'string') {
        similar = compiler;
        compiler = {};
    }
    compilers[altext] = Object.assign({}, compilers[similar || altext] || {}, compiler);
};

module.exports.getAltfile = function (filename, forced = false) {
    const parts = path.parse(filename);
    const basename = path.join(parts.dir, path.basename(parts.name, '.min'));
    const minified = forced || parts.name.endsWith('.min');

    const alts = Object.entries(compilers)
        .filter(entry => parts.ext === entry[1].ext)
        .sort((a, b) => a[1].ext === b[0] ? -1 : 1)
        .map(entry => entry[0])
        .filter(ext => minified || ext !== parts.ext)
    ;

    const alt = alts.find(alt => fs.existsSync(basename + alt));
    return alt ? basename + alt : null;
};

module.exports.canTranspile = function (filename) {
    const parts = path.parse(filename);

    const alts = Object.entries(compilers)
        .filter(entry => entry[0] !== entry[1].ext)
        .map(entry => entry[0])
    ;
    return alts.includes(parts.ext);
};

const transpile = async function (altfile, options) {
    altfile = path.resolve(altfile);

    for (const pattern of options.patterns) {
        if (!minimatch(altfile, pattern)) {
            options.logger.info(`skip ${altfile} (no match)`);
            return;
        }
    }

    const parts = path.parse(altfile);
    const compiler = compilers[parts.ext] || {};
    const outfile = path.resolve(options.outfile || path.changeExt(altfile, (options.minified ? '.min' : '') + compiler.ext));
    const cachefile = path.join(options.tmpdir, 'assetter', 'transpiled', altfile.replace(':', ';') + '.min-' + options.minified + '.json');

    // for skip
    if (!Object.keys(compiler).length) {
        options.logger.info(`skip ${altfile} (not supported)`);
        return;
    }
    if (options.minified && parts.name.endsWith('.min')) {
        options.logger.info(`skip ${altfile} (already minified)`);
        return;
    }
    if (outfile === altfile) {
        options.logger.info(`skip ${altfile} (same file)`);
        return;
    }

    const starttime = Date.now();

    // for cache
    if (!options.nocache && await fs.promises.mtime(cachefile) > await fs.promises.mtime(altfile)) {
        const value = JSON.parse((await fs.promises.readFile(cachefile)).toString());
        options.logger.info(`cache ${altfile} (${Date.now() - starttime}ms)`);
        return value;
    }

    // for compile
    return compiler.compile(altfile, options).then(async function (value) {
        value.filename = outfile;
        value.mapping.file = path.join(options.localdir, path.relative(options.rootdir, outfile)).replace(/\\/g, '/');
        const relative = path.relative(options.rootdir, altfile);
        if (relative.startsWith('..')) {
            value.mapping.sources = [path.basename(altfile)];
        }
        else {
            value.mapping.sources = [path.join(options.localdir, relative).replace(/\\/g, '/')];
        }

        if (compiler.callback) {
            compiler.callback(value);
        }
        await fs.promises.putFile(cachefile, JSON.stringify(value));
        options.logger.info(`done ${altfile} (${Date.now() - starttime}ms)`);
        return value;
    }, function (error) {
        options.logger.info(`fail ${altfile} (${Date.now() - starttime}ms)`);
        throw error;
    });
};

module.exports.transpile = async function (altfile, options = {}) {
    options = Object.assign({}, {
        maps: "",        // "": same location, string: specify relative, true: data URI, false: no map file, object: see code
        outfile: null,   // output filename (null: same direcotry)
        minified: false, // true: minify, false: human readable, null: auto detect by outfile
        nocache: false,  // true: nouse cache file
        nowrite: false,  // true: nowriting file
        logger: console, // logger instance
    }, options);

    if (options.minified === null) {
        if (options.outfile) {
            options.minified = path.parse(options.outfile).name.endsWith('.min');
        }
        else {
            options.minified = false;
        }
    }

    if (!(altfile instanceof Array)) {
        altfile = [altfile];
    }
    const result = Promise.all(altfile.map(file => transpile(file, options))).then(function (values) {
        values = values.filter(v => v);
        if (values.length) {
            // https://qiita.com/kozy4324/items/1a0f5c1269eafdebd3f8
            return {
                filename: options.outfile || path.combineName(',', ...values.map(v => v.filename)) || 'combined' + path.extname(values[0].filename),
                content: values.map(v => v.content).join("\n"),
                mapping: values.length === 1 ? values[0].mapping : {
                    version: 3,
                    sections: values.map((v, i) => ({
                        offset: {
                            line: values[i - 1] ? values[i - 1].content.split("\n").length : 0,
                            column: 0,
                        },
                        map: v.mapping,
                    })),
                },
            };
        }
    });

    return result.then(result => {
        if (!result) {
            return;
        }

        const results = [];
        const compiler = compilers[path.extname(result.filename)];
        const writeFile = function (filename, content) {
            if (!options.nowrite) {
                results.push(fs.promises.putFile(filename, content).then(function () {
                    options.logger.info(`write ${filename}`);
                }));
            }
        };

        if (options.maps === true) {
            const map = Buffer.from(JSON.stringify(result.mapping)).toString('base64');
            result.mappath = `data:application/json;charset=utf-8;base64,` + map;
            writeFile(result.filename, result.content += compiler.mappingURL(result.mappath));
        }
        else if (options.maps === false) {
            result.mappath = null;
            writeFile(result.filename, result.content);
        }
        else if (typeof (options.maps) === 'string') {
            const map = JSON.stringify(result.mapping, null, options.minified ? "" : "\t");
            const localname = `${path.basename(result.filename)}.map`;
            const url = path.join(options.maps, localname);
            result.mappath = path.join(path.dirname(result.filename), url);
            writeFile(result.filename, result.content += compiler.mappingURL(url.replace(/\\/g, '/')));
            writeFile(result.mappath, map);
        }
        else {
            const map = JSON.stringify(result.mapping, null, options.minified ? "" : "\t");
            for (const [relative, absolute] of Object.entries(options.maps)) {
                const localname = path.join(options.localdir, path.relative(options.rootdir, result.filename));
                const url = path.join(relative, `${localname}.map`);
                result.mappath = path.join(absolute, `${localname}.map`);
                writeFile(result.filename, result.content += compiler.mappingURL(url.replace(/\\/g, '/')));
                writeFile(result.mappath, map);
            }
        }
        return Promise.all(results).then(() => result);
    });
};
