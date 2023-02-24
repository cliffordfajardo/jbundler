import * as fs from "node:fs";
import * as path from "node:path";
import * as module from "node:module";
import * as esbuild from "esbuild";

import { createESBuildPlugin } from "./plugin.js";
import { createServerClientComponentsTransformPlugin } from "./plugins/rsc-server-client-components.js";
import { createStripExportsTransformPlugin } from "./plugins/strip-exports.js";

export { loadConfig } from "./config.js";

const builtins = new Set(module.builtinModules);

/** @type {import("./index.js").build} */
export async function build(config) {
  /** @type {import("esbuild").BuildResult} */
  let browserBuildResult;
  /** @type {import("esbuild").BuildResult} */
  let serverBuildResult;
  const rscEntriesCache = new Set();
  if (config.rsc) {
    const serverBuildOptions = createEsbuildServerOptions(
      config,
      rscEntriesCache
    );
    serverBuildResult = await runEsbuild(serverBuildOptions, "Server  |");
    const browserBuildOptions = createEsbuildBrowserOptions(
      config,
      rscEntriesCache
    );
    browserBuildResult = await runEsbuild(browserBuildOptions, "Browser |");
  } else {
    const browserBuildOptions = createEsbuildBrowserOptions(config);
    const serverBuildOptions = createEsbuildServerOptions(config);
    [browserBuildResult, serverBuildResult] = await Promise.all([
      runEsbuild(browserBuildOptions, "Browser |"),
      runEsbuild(serverBuildOptions, "Server  |"),
    ]);
  }

  const clientEntry =
    config.browser.publicPath +
    path
      .relative(
        config.browser.outdir,
        path.resolve(
          config.cwd,
          Object.entries(browserBuildResult.metafile.outputs).find(
            ([, output]) => output.entryPoint
          )[0]
        )
      )
      .replace(/\\/g, "/");

  const webpackMap = config.rsc
    ? createWebpackMap(config, rscEntriesCache, browserBuildResult)
    : "";

  writeFiles(browserBuildResult, clientEntry, "browser", webpackMap);
  writeFiles(serverBuildResult, clientEntry, "server", webpackMap);
}

/** @type {import("./index.js").watch} */
export async function watch(config) {}

/**
 *
 * @param {import("./config.js").JBundlerConfig} config
 * @param {Set<string>} rscEntriesCache
 * @returns {import("esbuild").BuildOptions}
 */
function createEsbuildBrowserOptions(config, rscEntriesCache = undefined) {
  const transformPlugins = [
    createStripExportsTransformPlugin(config.browser.stripExports),
  ];

  const rscEntries = Array.from(rscEntriesCache || []);

  return {
    absWorkingDir: config.cwd,
    entryPoints: [config.browser.entry, ...rscEntries],
    bundle: true,
    outdir: path.relative(config.cwd, config.browser.outdir),
    platform: "browser",
    sourcemap: true,
    target: ["es2019"],
    format: "esm",
    splitting: true,
    write: false,
    metafile: true,
    minify: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [
      {
        name: "jbundler-browser",
        setup(build) {
          build.onLoad({ filter: /jbundler\/build-target/ }, (args) => {
            return {
              contents: `export default "browser";`,
            };
          });
        },
      },
      createESBuildPlugin({ transformPlugins }),
    ],
  };
}

/**
 *
 * @param {import("./config.js").JBundlerConfig} config
 * @param {Set<string>} rscEntriesCache
 * @returns {import("esbuild").BuildOptions}
 */
function createEsbuildServerOptions(config, rscEntriesCache = undefined) {
  const transformPlugins = [
    createStripExportsTransformPlugin(config.server.stripExports),
  ];

  if (config.rsc) {
    if (!rscEntriesCache) {
      throw new Error("RSC entries cache not provided");
    }
    transformPlugins.push(
      createServerClientComponentsTransformPlugin(config, rscEntriesCache)
    );
  }

  return {
    absWorkingDir: config.cwd,
    entryPoints: [config.server.entry],
    bundle: true,
    outdir: path.relative(config.cwd, config.server.outdir),
    platform: "node",
    sourcemap: true,
    target: ["es2019"],
    format: "esm",
    splitting: true,
    write: false,
    conditions: ["react-server"],
    plugins: [
      {
        name: "jbundler-server",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (
              (args.path.startsWith("node:") ||
                builtins.has(args.path) ||
                (!args.path.startsWith(".") && !args.path.startsWith("/"))) &&
              args.path !== "jbundler/build-target" &&
              args.path !== "jbundler/client-entry" &&
              args.path !== "jbundler/webpack-map"
            ) {
              return { path: args.path, external: true, sideEffects: false };
            }
          });

          build.onLoad({ filter: /jbundler\/build-target/ }, (args) => {
            return {
              contents: `export default "server";`,
            };
          });
        },
      },
      createESBuildPlugin({ transformPlugins }),
    ],
  };
}

/**
 * @param {import("./config.js").JBundlerConfig} config
 * @param {Set<string>} rscEntriesCache
 * @param {import("esbuild").BuildResult} browserBuildResult
 * @returns {string}
 */
function createWebpackMap(config, rscEntriesCache, browserBuildResult) {
  // map rscEntriesCache input files to their output chunks
  /**
   * @type {Record<string, Record<string, {
   *  id: string;
   *  chunks: string[];
   *  name: string;
   * }>>}
   */
  const webpackMap = {};

  for (const [outputFile, output] of Object.entries(
    browserBuildResult.metafile.outputs
  )) {
    if (output.entryPoint) {
      for (const input of Object.keys(output.inputs)) {
        const inputPath = path.resolve(config.cwd, input);
        if (!rscEntriesCache.has(inputPath)) {
          continue;
        }

        webpackMap[input] = webpackMap[input] || {};
        const entryChunk =
          config.browser.publicPath +
          path.relative(
            config.browser.outdir,
            path.resolve(config.cwd, outputFile)
          );
        for (const exportKey of output.exports) {
          webpackMap[input][exportKey] = {
            id: entryChunk,
            name: exportKey,
            chunks: [
              entryChunk,
              ...output.imports.reduce((acc, c) => {
                if (!c.external && c.kind === "import-statement") {
                  acc.push(
                    config.browser.publicPath +
                      path.relative(
                        config.browser.outdir,
                        path.resolve(config.cwd, c.path)
                      )
                  );
                }
                return acc;
              }, []),
            ],
          };
        }
      }
    }
  }

  return JSON.stringify(JSON.stringify(webpackMap));
}

/**
 *
 * @param {import("esbuild").BuildResult} buildResult
 * @param {string} clientEntry
 * @param {"browser" | "server"} target
 * @param {string} webpackMap
 */
function writeFiles(buildResult, clientEntry, target, webpackMap) {
  const checkedDirs = new Set();
  for (const output of buildResult.outputFiles) {
    const dir = path.dirname(output.path);
    if (!checkedDirs.has(dir) && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      checkedDirs.add(dir);
    }

    let toWrite = output.text
      .replace(
        /\/___virtual___client___entry___should___be___replaced___at___build___time___\.js/g,
        clientEntry
      )
      .replace(
        /___virtual___target___should___be___replaced___at___build___time___/g,
        target
      )
      .replace(
        /\"___virtual___webpack__map___should___be___replaced___at___build___time___\"/g,
        webpackMap
      );
    fs.writeFileSync(output.path, toWrite, "utf8");
  }
}

/**
 * @param {import("esbuild").BuildOptions} options
 * @param {string} label
 */
async function runEsbuild(options, label) {
  const buildResult = await esbuild.build(options);
  if (buildResult.warnings.length > 0) {
    console.warn(
      esbuild.formatMessages(buildResult.warnings, {
        kind: "warning",
        color: true,
      })
    );
  }
  if (buildResult.errors.length > 0) {
    console.error(
      esbuild.formatMessages(buildResult.errors, {
        kind: "error",
        color: true,
      })
    );
    throw new Error(`${label} build failed`);
  }

  if (buildResult.warnings.length > 0) {
    console.log(`${label} build completed with warnings`);
  } else {
    console.log(`${label} build completed`);
  }

  return buildResult;
}