
exports.for = function (API) {

	var exports = {};

	exports.turn = function (resolvedConfig) {

		return API.ASYNC([
			"GULP",
			"GULP_DEBUG",
			"GULP_PLUMBER",
			"GULP_FILTER",
			"GULP_REPLACE"
		], function (GULP, GULP_DEBUG, GULP_PLUMBER, GULP_FILTER, GULP_REPLACE) {

			var programDescriptorPath = API.getRootPath();
			var programDescriptor = API.programDescriptor;

			var sourcePath = API.PATH.dirname(programDescriptorPath);

			var pubPath = API.getTargetPath();

			var templatePath = API.PATH.join(__dirname, "template");
			var templateDescriptorPath = API.PATH.join(templatePath, "package.json");
			var templateDescriptor = API.FS.readJsonSync(templateDescriptorPath);

			API.ASSERT.equal(typeof templateDescriptor.directories.deploy, "string", "'directories.deploy' must be set in '" + templateDescriptorPath + "'");

			var relativeBaseUri = "";

			return programDescriptor.getBootPackageDescriptor().then(function (packageDescriptor) {

				packageDescriptor = packageDescriptor._data;

				return API.Q.denodeify(function (callback) {

					function copy (fromPath, toPath, callback) {

						API.console.debug("Copying and transforming fileset", fromPath, "to", toPath, "...");

						var domain = require('domain').create();
						domain.on('error', function(err) {
							// The error won't crash the process, but what it does is worse!
							// Though we've prevented abrupt process restarting, we are leaking
							// resources like crazy if this ever happens.
							// This is no better than process.on('uncaughtException')!
							console.error("UNHANDLED DOMAIN ERROR:", err.stack, new Error().stack);
							process.exit(1);
						});
						domain.run(function() {

							try {

								var isDirectory = API.FS.statSync(fromPath).isDirectory();

								var destinationStream = null;

								if (isDirectory) {
									destinationStream = GULP.dest(toPath);
								} else {
									destinationStream = GULP.dest(API.PATH.dirname(toPath));
								}

								destinationStream.once("error", function (err) {
									return callback(err);
								});

								destinationStream.once("end", function () {

									API.console.debug("... done");

									return callback();
								});

								var filter = GULP_FILTER([
									'index.html',
									'**/index.html'
								]);

								// TODO: Respect gitignore by making pinf walker into gulp plugin. Use pinf-package-insight to load ignore rules.
								var stream = null;
								if (isDirectory) {
									stream = GULP.src([
										"**",
										"!.pub/",
										"!.pub/**",
										"!npm-debug.log",
										"!node_modules/",
										"!node_modules/**"
									], {
										cwd: fromPath
									});
								} else {
									stream = GULP.src([
										API.PATH.basename(fromPath)
									], {
										cwd: API.PATH.dirname(fromPath)
									});											
								}

								stream
									.pipe(GULP_PLUMBER())

								if (API.VERBOSE) {
									stream = stream
										.pipe(GULP_DEBUG({
											title: '[pinf-to-browser]',
											minimal: true
										}))
								}

								stream = stream
									.pipe(filter)
									// TODO: Add generic variables here and move to `to.pinf.lib`.
									.pipe(GULP_REPLACE(/%[^%]+%/g, function (matched) {
										// TODO: Arrive at minimal set of core variables and options to add own.
										if (matched === "%boot.loader.uri%") {
											return (relativeBaseUri?relativeBaseUri+"/":"") + "bundles/loader.js";
										} else
										if (matched === "%boot.bundle.uri%") {
											return (relativeBaseUri?relativeBaseUri+"/":"") + ("bundles/" + packageDescriptor.main).replace(/\/\.\//, "/");
										}
										return matched;
									}))
									.pipe(filter.restore())											
									.pipe(destinationStream);

								return stream.once("error", function (err) {
									err.message += " (while running gulp)";
									err.stack += "\n(while running gulp)";
									return callback(err);
								});
							} catch (err) {
								return callback(err);
							}
						});
					}

					function copyFiles (fromPath, toPath, callback) {

						API.console.debug("Copying and transforming program from", fromPath, "to", toPath);

						return API.FS.remove(toPath, function (err) {
							if (err) return callback(err);

							return copy(API.PATH.join(templatePath), toPath, function (err) {
								if (err) return callback(err);

								return copy(fromPath, API.PATH.join(toPath, templateDescriptor.directories.deploy), callback);
							});
						});
					}

					function copyCustomTemplates (callback) {
						if (!resolvedConfig.templates) return callback(null);
						var waitfor = API.WAITFOR.serial(callback);
						for (var uri in resolvedConfig.templates) {
							waitfor(uri, function (uri, callback) {
								return copy(
									API.PATH.join(fromPath, config.templates[uri]),
									API.PATH.join(pubPath, uri),
									callback
								);
							});
						}
						return waitfor();
					}

					function writeProgramDescriptor (callback) {

						var pubProgramDescriptorPath = API.PATH.join(pubPath, "program.json");

						// TODO: Use PINF config tooling to transform program descriptor from one context to another.

						var bundles = {};

						if (
							packageDescriptor.exports &&
							packageDescriptor.exports.bundles
						) {
							for (var bundleUri in packageDescriptor.exports.bundles) {
								bundles[bundleUri] = {
									"source": {
										"path": API.PATH.relative(API.PATH.dirname(pubProgramDescriptorPath), programDescriptorPath),
										"overlay": {
											"layout": {
												"directories": {
											        "bundles": API.PATH.relative(API.PATH.dirname(programDescriptorPath), API.PATH.join(pubPath, templateDescriptor.directories.deploy))
											    }
										    }
										}
									},
									"path": "./" + API.PATH.join(templateDescriptor.directories.deploy, packageDescriptor.exports.bundles[bundleUri])
								};
							}
						}

						var descriptor = {
							boot: {
								runtime: API.PATH.relative(API.PATH.dirname(pubProgramDescriptorPath), API.getRuntimeDescriptorPath())
							}
						};

						// TODO: Add more program properties needed to seed the runtime system.

						if (Object.keys(bundles).length > 0) {
							descriptor.exports = {
								"bundles": bundles
							};
						}

						descriptor.config = resolvedConfig.config || {};

						API.console.debug(("Writing program descriptor to: " + pubProgramDescriptorPath).yellow);
						return API.FS.writeFile(pubProgramDescriptorPath, JSON.stringify(descriptor, null, 4), callback);
					}


					if (resolvedConfig.wwwBasePath) {
						return API.FS.remove(pubPath, function (err) {
							if (err) return callback(err);

							return copy(API.PATH.join(templatePath), pubPath, function (err) {
								if (err) return callback(err);

								return writeProgramDescriptor(function (err) {
									if (err) return callback(err);

									var targetPath = API.PATH.join(pubPath, "www");

									if (resolvedConfig.symlinkBasePath) {
										API.FS.removeSync(targetPath);
										return API.FS.symlink(resolvedConfig.wwwBasePath, targetPath, callback);
									} else {
										return copy (resolvedConfig.wwwBasePath, targetPath, callback);
									}
								});
							});
						});
					}

					var fromPath = null;
					if (resolvedConfig.bundlesBasePath) {
						fromPath = resolvedConfig.bundlesBasePath;
					} else
					if (
						packageDescriptor.layout &&
						packageDescriptor.layout.directories &&
						packageDescriptor.layout.directories.bundles
					) {
						fromPath = API.PATH.join(sourcePath, packageDescriptor.layout.directories.bundles);
					} else {
						fromPath = API.PATH.join(sourcePath, "bundles");
					}

					return copyFiles(fromPath, pubPath, function (err) {
						if (err) return callback(err)

						return copyCustomTemplates(function (err) {
							if (err) return callback(err);

							return writeProgramDescriptor(function (err) {
								if (err) return callback(err);

								var targetPath = API.PATH.join(pubPath, templateDescriptor.directories.deploy);

								API.FS.removeSync(targetPath);

								return API.FS.symlink(fromPath, targetPath, callback);
							});
						});
					});
				})();
			});
		});
	}

	exports.spin = function (resolvedConfig) {

		return API.Q.denodeify(function (callback) {
			try {

				var programDescriptorPath = API.getRootPath();
				var programDescriptor = API.programDescriptor;

				var pubPath = API.getTargetPath();

				var templatePath = API.PATH.join(__dirname, "template");
				var templateDescriptorPath = API.PATH.join(templatePath, "package.json");
				var templateDescriptor = API.FS.readJsonSync(templateDescriptorPath);

				function runServer (callback) {

					API.console.verbose("Starting NodeWebkit ...");

					var commands = [];

					// TODO: Use pinf-it-package-insight or derivative to detect if program is ready to run.
					// TODO: Start PINF program instead of calling npm directly here. i.e. The bundled program should
					//       be wrapped in a pinf-to-pinf-program wrapper/bundle/host/runtime which embeds npm or finds
					//       it in the environment.
					if (!API.FS.existsSync(API.PATH.join(pubPath, "node_modules"))) {
						commands.push('npm install --production --unsafe-perm');
					}

					commands.push('BO_callPlugin "bash.origin.nw@0.1.0" run "' + pubPath + '"');

					return API.runProgramProcess({
						label: API.getDeclaringPathId() + "/" + resolvedConfig.$to,
						commands: commands,
						cwd: pubPath
					}, callback);
				}

				return runServer(callback);
				
			} catch (err) {
				return callback(err);
			}
		})();
	}

	return exports;
}
