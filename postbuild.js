#!/usr/bin/env node
`use strict`;

/**
 * This postbuild script handles common tasks related to updating and releasing mods. *
 * Copyright Fluffy
 */

var doc = `
Usage:
    mod create
    mod update [options]
    mod release [-p -d -M] [options]
    mod update-remote <git-user> [<git-repo>] [options]

Options:
    -n <string>, --name <string>            Name of mod, if not specified attempts to find ModConfig, 
                                            and if that doesn't exist the current working directory.
    -s <path>, --source <path>              Source directory of mod, defaults to current working directory.
    -t <path>, --target <path>              Target install dir relative to RimWorld/Mods, if not specified 
                                            defaults to the value of --source, and falls back on the name
                                            of the current working directory.
    -r, --reset-tag                         Purge local git tags, fetch remote tags.
    -v <integer>, --verbosity <integer>     Verbosity of output. Defaults to minimum 0, 1 gives useful 
                                            debugging output, and 2 prints EVERYTHING!.
    -m, --mock                              Do not take any actions, but print what actions would be taken.
    -x, --nostyle                           Do not stylize output. This may be useful when the script is called
                                            from a console that doesn't support styling (i.e. VS).
    -R, --build-release                     Build in release mode (only relevant for mod update).
    -c <path>, --config <path>              Path to config file [default: ./config.json]
    -h, --help                              Print this message.

Release options:
    -p, --prerelease                        Create a prerelease on github (defaults to public release). Implies --no-steam option.
    -d, --draft                             Create a draft release on github (defaults to a finalized release).
    -M, --major                             Bump major version.
    -f, --force-commit                      Force git commit && git push if needed. 
                                            Will auto generate a commit message based on the version string.
    -V, --no-version-bump                   Do not bump version. Note that this will break github releases for now.
    -T <string>, --forum-title <string>     Forum title addition (defaults to a last updated timestamp).
    --no-build                              Do not build assembly/assemblies.
    --no-merge                              Skip merged release.
    --no-steam                              Skip steam release.
    --no-github                             Skip github release.
    --no-forum                              Skip forum post update.`;

// required packages
const { docopt } = require("docopt"),
  gittoken = require("./git_token.js"),
  fs = require("fs"),
  finder = require("fs-finder"),
  path = require("path"),
  spawn = require("child_process").spawnSync,
  spawnAsync = require("child_process").spawn,
  exec = require("child_process").exec,
  GitHubApi = require("github"),
  parseGit = require("parse-git-config"),
  marked = require("marked"),
  html2bbcode = require("html2bbcode").HTML2BBCode,
  rimraf = require("rimraf"),
  series = require("async/series"),
  ncp = require("ncp"),
  archiver = require("archiver"),
  xml2js = require("xml2js"),
  striptags = require("striptags"),
  steamWorkshopUpdate = require("./workshop"),
  forumPostUpdate = require("./forum"),
  manifestUpdate = require("./manifest"),
  merge = require("lodash.merge"),
  moment = require("moment"),
  {
    MergeVersions,
    GetVersionBranches,
  } = require("../TOOLS/VersionMerger/dist/index");

// process arguments
var args = docopt(doc);
var mock = args["--mock"];
var verbosity = args["--verbosity"];

if (verbosity > 0) console.log("args", args);

// prototype extensions
(function () {
  var styles = {
    bold: [1, 22],
    black: [30, 39],
    red: [31, 39],
    green: [32, 39],
    yellow: [33, 39],
    white: [37, 39],
    grey: [90, 39],
    bgRed: [41, 49],
    bgGreen: [42, 49],
    bgWhite: [47, 49],
  };
  var prefixes = {
    green: "[ OK ]\t\t",
    red: "[ ERROR ]\t",
    yellow: "[ WARNING ]\t",
    bgGreen: "[ DONE ]\t",
  };
  String.prototype.stylize = function (styleId) {
    if (!styleId) return this;
    if (args["--nostyle"])
      return (prefixes[styleId] ? prefixes[styleId] : "") + this;
    var val = styles[styleId];
    return "\u001b[" + val[0] + "m" + this + "\u001b[" + val[1] + "m";
  };

  Array.prototype.last = function () {
    return this ? this[this.length - 1] : undefined;
  };
})();

// globals
var config = {
  git_token: gittoken,
  app_id: 294100,
  steam_visibility: 0,
  license_path: path.join(__dirname, "LICENSE"),
  forum_thread: "https://ludeon.com/forums/index.php?topic=16120",
  author: "Fluffy",
  detect_mod_dir_max_recursion: 5,
  tags: [],
  current_alpha: 1,
  donate_badge: {
    steam: "http://i.imgur.com/6P7Ap79.gif",
    github: "http://i.imgur.com/EjWiUwx.gif",
  },
};

merge(config, require(args["--config"]));

var paths = {
  targetDirName: undefined,
  target: undefined,
  source: undefined,
  preview: undefined,
  about: undefined,
  readme: undefined,
  publishedfileid: undefined,
  config: undefined,
  about: undefined,
  version: undefined,
  archive: undefined,
  project: undefined,
  solution: undefined,
  assemblies: undefined,
};

var templates = {
  description_footer: fs.readFileSync(
    path.join(__dirname, "templates", "DescriptionFooter.md"),
    "utf-8"
  ),
  version: fs.readFileSync(
    path.join(__dirname, "templates", "Version.md"),
    "utf-8"
  ),
  description: "",
};

var mod;

if (args["create"]) {
  series([runCookiecutter], finalize);
}

if (args["update-remote"]) {
  series([resolvePaths, getModConfig, updateRemote, updateModConfig], finalize);
}

if (args.update) {
  series(
    [
      resolvePaths,
      getModConfig,
      updateModConfig,
      updateAbout,
      updateReadme,
      updateLicense,
      updateAssemblyInfo,
      build,
      clearOutTarget,
      copyFiles,
    ],
    finalize
  );
}

if (args.release) {
  series(
    [
      resolvePaths,
      checkGitStatus,
      getModConfig,
      updateModConfig,
      updateAbout,
      updateReadme,
      updateLicense,
      updateAssemblyInfo,
      updateManifest,
      build,
      gitCommitPush,
      clearOutTarget,
      copyFiles,
      createArchive,
      createGitHubRelease,
      clearOutTargetMerge,
      mergeVersions,
      createSteamRelease,
      updateForumPost,
    ],
    finalize
  );
}

//////////////////////////////////// BUILD STEPS /////////////////////////////////////
function runCookiecutter(cb) {
  const ck = spawnAsync(
    "cookiecutter",
    ["gh:fluffy-mods/cookiecutter-rimworld-mod-development"],
    { stdio: "inherit" }
  );

  ck.on("error", cb);
  ck.on("exit", (code, signal) => {
    if (code !== null && code != 0)
      return cb(`cookiecutter exited with statuscode: ${code}`);
    return cb();
  });
}

function getModConfig(cb) {
  try {
    mod = JSON.parse(fs.readFileSync(paths.config, "utf-8"));
    if (args["--name"]) mod.name = args["--name"];

    // make sure we add build number.
    if (!mod.version.build) mod.version.build = 0;

    // add packageId if necessary
    if (!mod.packageId || !mod.packageId.match(/^[a-z]+(?:\.[a-z]+)+$/i))
      mod.packageId = `fluffy.${mod.name
        .trim()
        .replace(/\W/g, "")
        .toLowerCase()}`;

    console.log(`ModConfig.json found at ${paths.config}`.stylize("green"));
  } catch (e) {
    git_info = getGitInfo();

    mod = {
      name: args["--name"] || sourceDirName(),
      version: {
        alpha: config.current_alpha,
        major: 0,
        minor: 0,
        build: 0,
      },
      visibility: 0,
      publishedfileid: getPublishedFileID(false),
      git_repo: git_info.repo,
      git_user: git_info.user,
      contributors: getContributors(),
      changenote: getChangeNote(),
      tags: config.tags,
    };
    fs.writeFileSync(paths.config, JSON.stringify(mod, null, 4), "utf-8");
    console.log(`ModConfig.json created at ${paths.config}`.stylize("yellow"));
  }
  if (verbosity) console.log("mod", mod);

  if (cb) return cb();
}

function updateRemote(cb) {
  let git = {
    repo: args["<git-repo>"] || mod.git_repo,
    user: args["<git-user>"] || mod.git_user,
  };
  let remote = `https://github.com/${git.user}/${git.repo}.git`;

  if (mock) {
    console.log(`Setting remote to: ${remote}`);
    return cb();
  }

  try {
    runGitCommand(["remote", "set-url", "origin", remote]);
    mod.git_user = git.user;
    mod.git_repo = git.repo;
    console.log(`Remote set to ${remote}`.stylize("green"));
    return cb();
  } catch (err) {
    cb(err);
  }
}

function updateModConfig(cb) {
  if (mock) {
    console.log(`Setting changenote to: ${getChangeNote()}`);
    console.log(
      `Setting contributors to: ${JSON.stringify(
        getContributors(mod.contributors),
        null,
        4
      )}`
    );
    console.log(`Steam publishedFileId: ${getPublishedFileID()}`);
    return cb();
  }

  try {
    // bump version string
    if (args["--major"]) {
      mod.version.major++;
      mod.version.minor = 0;
      mod.version.build++;
    } else if (args.release && !args["--no-version-bump"]) {
      mod.version.minor++;
      mod.version.build++;
    } else if (!args.release && !args["--no-version-bump"]) {
      mod.version.build++;
    }

    // update changenotes
    mod.changenote = getChangeNote();
    mod.changenotes = getChangeNotes();

    // update contributors
    mod.contributors = getContributors(mod.contributors);

    // set publishedfileid if needed
    if (typeof mod.publishedfileid == "undefined")
      mod.publishedfileid = getPublishedFileID();

    // version tags
    GetVersionBranches(paths.source)
      // async.series doesn't allow for async tasks (go figure), so we're back in callback hell
      .then((versions) => {
        mod.tags = versions;

        // done!
        fs.writeFileSync(paths.config, JSON.stringify(mod, null, 4), "utf-8");
        console.log(`ModConfig.json updated`.stylize("green"));
        return cb();
      })
      .catch(cb);
  } catch (err) {
    console.log(err);
    return cb(err);
  }
}

function updateAbout(cb) {
  if (mock) return cb();

  // make sure About.xml exists
  try {
    fs.statSync(paths.about);

    // parse into xml
    var xml_string = fs.readFileSync(paths.about, "utf-8");
    xml2js.parseString(xml_string, (err, result) => {
      if (err) return cb(err);

      // update fields
      result.ModMetaData.name = mod.name;
      result.ModMetaData.packageId = mod.packageId;
      delete result.ModMetaData.targetVersion; // blank it out.
      result.ModMetaData.supportedVersions = {
        li: getRimWorldVersion(false, true),
      };
      result.ModMetaData.description = getDescription(
        "rimworld",
        false,
        false,
        false
      );

      try {
        // get dependencies
        if (fs.existsSync(paths.depends)) {
          let dependencies = JSON.parse(
            fs.readFileSync(paths.depends, "utf-8")
          );
          if (dependencies.depends) {
            result.ModMetaData.modDependencies = { li: [] };
            for (let depend of dependencies.depends) {
              result.ModMetaData.modDependencies.li.push({
                packageId: depend.id,
                displayName: depend.name,
                steamWorkshopUrl: depend.steam
                  ? `steam://url/CommunityFilePage/${depend.steam}`
                  : undefined,
                downloadUrl: depend.url,
              });
            }
          }
          if (dependencies.incompatible) {
            result.ModMetaData.incompatibleWith = {
              li: dependencies.incompatible,
            };
          }
          if (dependencies.before) {
            result.ModMetaData.loadBefore = {
              li: dependencies.before,
            };
          }
          if (dependencies.after) {
            result.ModMetaData.loadAfter = {
              li: dependencies.after,
            };
          }
        }
      } catch (err) {
        console.log(`Error dealing with dependencies: ${err}`);
      }

      // store xml
      try {
        var builder = new xml2js.Builder();
        xml_string = builder.buildObject(result);
        fs.writeFileSync(paths.about, xml_string, "utf-8");
        console.log(`About.xml updated`.stylize("green"));
        if (verbosity > 1) console.log(xml_string);
        return cb();
      } catch (err) {
        return cb(err);
      }
    });
  } catch (err) {
    createAbout();
    return cb();
  }
}

function updateReadme(cb) {
  if (mock) return cb();

  try {
    fs.writeFileSync(
      paths.readme,
      getDescription("github", true, true, false),
      "utf-8"
    );
    console.log(`Readme.md updated`.stylize("green"));
    return cb();
  } catch (err) {
    return cb(err);
  }
}

function updateLicense(cb) {
  if (mock) return cb();

  ncp(config.license_path, paths.license, (err) => {
    if (err) return cb("Error in license update:" + err);
    else {
      console.log(`LICENSE updated`.stylize("green"));
      return cb();
    }
  });
}

function checkGitStatus(cb) {
  let clean = true;
  var branch = runGitCommand(["rev-parse", "--abbrev-ref HEAD"]);
  var uncommited_work = runGitCommand(["status", "--porcelain"]);
  if (uncommited_work != "") {
    clean = false;
    if (!args["--force-commit"])
      return cb("Uncommited work!\n" + uncommited_work);
  }

  var commits_not_pushed = runGitCommand(["log", `origin/${branch}..`]);
  if (commits_not_pushed != "") {
    clean = false;
    if (!args["--force-commit"])
      return cb("Commits not pushed!\n" + commits_not_pushed);
  }

  if (clean) console.log(`Git repository clean`.stylize("green"));
  else
    console.log(
      `Uncommited / pushed work - forced to continue`.stylize("yellow")
    );
  return cb();
}

function gitCommitPush(cb) {
  console.log(
    runGitCommand([
      "commit",
      "-am",
      `"Release ${getVersionString()} [nolog]"`,
    ]).stylize("green")
  );
  console.log(runGitCommand(["push"]).stylize("green"));
  return cb();
}

function resolvePaths(cb) {
  // change cwd?
  if (args["--source"]) process.cwd(args["--source"]);

  paths.source = process.cwd();
  var recursion = 0;

  // check if this is a mod directory
  while (
    !isModDir(paths.source) &&
    recursion < config.detect_mod_dir_max_recursion
  ) {
    try {
      paths.source = path.resolve(paths.source, "./..");
      recursion++;
      console.log(paths.source, recursion);
    } catch (err) {
      fail(err);
    }
  }

  if (!isModDir(paths.source))
    cb(paths.source + " does not appear to be a mod directory.");

  process.cwd(paths.source);

  // resolve paths
  // target paths
  paths.targetDirName = args["--target"] || sourceDirName();
  paths.target = path.join(config.rw_base_path, "Mods", paths.targetDirName);
  paths.preview = path.join(paths.target, "About", "Preview.png");
  paths.publishedfileid = path.join(
    paths.target,
    "About",
    "PublishedFileId.txt"
  );
  paths.version = path.join(config.rw_base_path, "version.txt");

  // source paths
  paths.config = path.join(paths.source, "Source", "ModConfig.json");
  paths.about = path.join(paths.source, "About", "About.xml");
  paths.depends = path.join(paths.source, "About", "dependencies.json");
  paths.readme = path.join(paths.source, "Readme.md");
  paths.assemblies = path.join(paths.source, "Assemblies");
  paths.license = path.join(paths.source, "LICENSE");
  paths.solution = finder
    .from(paths.source)
    .exclude("*.cache")
    .findFile("*.sln");
  paths.assemblyInfo = finder
    .from(paths.source)
    .exclude("*.cache")
    .findFile("AssemblyInfo.cs");

  // try to find description template
  try {
    templates.description = fs.readFileSync(
      path.join(paths.source, "Source", "Description.md"),
      "utf-8"
    );
  } catch (err) {
    console.log(`Couldn't find description.md`.stylize("yellow"));
  }

  if (verbosity) console.log("paths", paths);

  // done!
  console.log("Paths resolved".stylize("green"));
  cb();
}

function updateAssemblyInfo(cb) {
  if (!paths.assemblyInfo) return cb("AssemblyInfo.cs not found");

  let info = fs.readFileSync(paths.assemblyInfo, "utf-8");

  // update Assembly FILE version with full version
  info = info.replace(
    /AssemblyFileVersion\(\s?"(\d+)\.(\d+)\.(\d+)(?:\.\d+)?"\s?\)\]$/gm,
    function (match, major, minor, build, revision) {
      if (verbosity > 0) console.log(match, mod.version);
      return `AssemblyFileVersion("${mod.version.major}.${mod.version.minor}.${mod.version.build}")]`;
    }
  );
  info = info.replace(
    /AssemblyVersion\(\s?"(\d+)\.(\d+)\.(\d+)(?:\.\d+)?"\s?\)\]$/gm,
    function (match, major, minor, build, revision) {
      if (verbosity > 0) console.log(match, mod.version);
      return `AssemblyVersion("${mod.version.major}.0.0")]`;
    }
  );

  fs.writeFileSync(paths.assemblyInfo, info, "utf-8");

  // done!
  console.log("AssemblyInfo updated".stylize("green"));
  cb();
}

function build(cb) {
  if (args["release"] || args["--build-release"]) return buildRelease(cb);
  else return buildDebug(cb);
}

function buildRelease(cb) {
  clearAssemblies();

  // spawn process
  msbuild = exec(
    `"` +
      config.msbuild_path +
      `" "${paths.solution}" /p:Configuration="Release" /p:PostBuildEvent=""`,
    function (err, stdout, stderr) {
      if (err) {
        console.log(`MsBuild failed: \n${stderr}\n\n${stdout}`);
        return cb(err);
      }
      console.log("Solution built (RELEASE)".stylize("green"));
      return cb();
    }
  );
}

function buildDebug(cb) {
  clearAssemblies();

  // spawn process
  if (verbosity) {
    console.log(
      `"${config.msbuild_path}" "${paths.solution}" /p:Configuration="Debug" /p:PostBuildEvent=""`
    );
  }

  msbuild = exec(
    `"${config.msbuild_path}" "${paths.solution}" /p:Configuration="Debug" /p:PostBuildEvent=""`,
    function (err, stdout, stderr) {
      if (err) {
        console.log(`MsBuild failed: \n${stderr}\n\n${stdout}`);
        return cb(err);
      }
      console.log("Solution built (DEBUG)".stylize("green"));
      return cb();
    }
  );
}

function clearAssemblies() {
  if (mock) {
    console.log("Removing all files in " + paths.assemblies);
  }

  rimraf(paths.assemblies, (err) => {
    if (err)
      console.log(
        `Error removing files in ${paths.assemblies}`.stylize("bgRed")
      );
  });
}

function createSteamRelease(cb) {
  if (args["--no-steam"] || args["--prerelease"] || args["--draft"]) {
    console.log("Skipping steam update".stylize("yellow"));
    return cb();
  }
  if (mock) {
    console.log("Pushing steam update");
    return cb();
  }

  return steamWorkshopUpdate(
    paths.target,
    mod.changenote,
    getDescription("steam"),
    false
  )
    .then((_) => {
      console.log("Steam release completed".stylize("green"));
      return cb();
    })
    .catch(cb);
}

function updateManifest(cb) {
  if (args["--no-github"] || args["--prerelease"] || args["--draft"]) {
    console.log("Skipping manifest update".stylize("yellow"));
    return cb();
  }
  if (mock) {
    console.log("Updating manifest");
    return cb();
  }

  var path_to_manifest = path.join(paths.source, "About", "Manifest.xml");
  return manifestUpdate(
    mod,
    path_to_manifest,
    getVersionString(),
    getRimWorldVersion(false, true)
  )
    .then((_res) => {
      console.log("Manifest updated".stylize("green"));
      return cb();
    })
    .catch(cb);
}

function updateForumPost(cb) {
  if (args["--no-forum"]) {
    console.log("Skipping forum update".stylize("yellow"));
    return cb();
  }
  if (mock) {
    console.log("Updating forum");
    return cb();
  }
  return forumPostUpdate(args["--forum-title"], mod.changenotes)
    .then((_res) => {
      console.log("Forum post updated".stylize("green"));
      return cb();
    })
    .catch(cb);
}

function createGitHubRelease(cb) {
  if (args["--no-github"]) {
    console.log("Skipping github update".stylize("yellow"));
    return cb();
  }
  if (mock) {
    console.log("Creating github release");
    return cb();
  }

  github = new GitHubApi({
    protocol: "https",
    host: "api.github.com",
    headers: {
      "user-agent": "mod-update-script",
    },
    Promise: global.Promise,
    timeout: 20000,
  });

  github.authenticate({
    type: "token",
    token: config.git_token,
  });

  github.repos.createRelease(
    {
      owner: mod.git_user,
      repo: mod.git_repo,
      tag_name: "v" + getVersionString(),
      name: `${mod.name} v${getVersionString()} (${getRimWorldVersion().join(
        "."
      )})`,
      body: args["--major"] ? getDescription("github") : mod.changenote,
      draft: args["--draft"],
      prerelease: args["--prerelease"],
    },
    function (err, res) {
      if (err) return cb(err);

      console.log("GitHub release created".stylize("green"));
      github.repos.uploadAsset(
        {
          owner: mod.git_user,
          repo: mod.git_repo,
          id: res.id,
          filePath: paths.archive,
          name: mod.name + ".zip",
          label: mod.name + " " + getVersionString(),
        },
        function (err, res) {
          if (err) return cb(err);

          console.log("Archive uploaded.".stylize("green"));

          // pull the new tag from the repo
          runGitCommand(["pull", "--tags"]);

          return cb();
        }
      );
    }
  );
}

function clearOutTargetMerge(cb) {
  if (args["--no-merge"]) return cb();
  clearOutTarget(cb);
}

function clearOutTarget(cb) {
  if (mock) {
    console.log("Removing all files in " + paths.target);
    return cb();
  }

  rimraf(paths.target, (err) => {
    if (err) return cb(err);
    console.log(`Cleared out target`.stylize("green"));
    return cb();
  });
}

function copyFiles(cb) {
  if (mock) {
    console.log(`Copying files from ${paths.source} to ${paths.target}`);
    return cb();
  }

  ncp(paths.source, paths.target, { filter: filter }, (err) => {
    if (err) return cb(err);
    console.log(
      ("Moved files from " + paths.source + " to " + paths.target).stylize(
        "green"
      )
    );
    return cb();
  });
}

function mergeVersions(cb) {
  if (args["--no-merge"]) {
    console.log(`Skipping merged release`.stylize("yellow"));
    return cb();
  }

  if (mock) {
    console.log(`Creating merged release at ${paths.target}.`);
    return cb();
  }

  // just frigging always use naive mode, okay?
  MergeVersions(paths.source, paths.target, filter, mock, true, verbosity)
    .then((_) => {
      console.log(`Created merged release at ${paths.target}`.stylize("green"));
      cb();
    })
    .catch((err) => cb(err));
}

function createArchive(cb) {
  paths.archive = path.join(
    config.paths.archives,
    `${mod.name} v${getVersionString()}.zip`
  );

  if (mock) {
    console.log(
      `Creating archive at ${paths.archive}, adding all files at ${paths.target}`
    );
    return cb();
  }

  // open a stream
  var out = fs.createWriteStream(paths.archive);

  // open archive
  var archive = archiver("zip", { store: true });

  // catch errors
  archive.on("error", cb);

  // pipe to file
  archive.pipe(out);

  // add our files
  archive.directory(paths.target, paths.targetDirName);
  archive.finalize();

  // listen for complete event
  out.on("close", (err) => {
    if (err) return cb(err);

    console.log(`Created release archive at ${paths.archive}`.stylize("green"));
    return cb();
  });
}

function finalize(err, value) {
  if (err) fail(err);
  if (mod)
    console.log(
      `\t${mod.name} v${mod.version.major}.${mod.version.minor}.${mod.version.build}` +
        ` || RimWorld v${getRimWorldVersion().join(".")}\t`.stylize("bgGreen")
    );
  console.log("\tAll done!\t".stylize("bgGreen"));
}

///////////////////////////////////// HELPERS ///////////////////////////////////////
function fail(reason) {
  console.log(reason.stack);
  console.error(reason.toString().stylize("red"));
  process.exit(1);
}

function getPublishedFileID(failhard = args.release && !args["--no-steam"]) {
  try {
    var fileid = fs.readFileSync(paths.publishedfileid, "utf-8").trim();
    // write to source dir if it exists
    fs.writeFileSync(
      path.join(paths.source, "About", "PublishedFileId.txt"),
      fileid,
      "utf-8"
    );
    return fileid;
  } catch (err) {
    console.log("no PublishedFileId found".stylize("yellow"));
    return undefined;
  }
}

function createAbout() {
  // create object with default values
  var about = {
    ModMetaData: {
      name: mod.name,
      author: config.author,
      url: config.forum_thread,
      targetVersion: getRimWorldVersion().join("."),
      description: getDescription("rimworld", false, false, false),
    },
  };

  // store
  try {
    var builder = new xml2js.Builder();
    xml_string = builder.buildObject(about);
    fs.writeFileSync(paths.about, xml_string, "utf-8");
    console.log(`About.xml created`.stylize("yellow"));
    if (verbosity > 1) console.log(xml_string);
  } catch (err) {
    fail(err);
  }
}

function getDescription(
  format = "steam",
  badges = format == "github",
  footer = format == "steam",
  changenotes = format == "github"
) {
  if (format != "steam" && format != "github" && format != "rimworld")
    fail("Unrecognized description format");

  // ugh, we need this local to be available in the footer template.
  global.format = format;

  var desc_parts = [];

  // git badges (for Readme.MD)
  if (badges) desc_parts.push(getGithubBadges());

  // main description
  desc_parts.push(fill(templates.description));

  // contributors
  if (mod.contributors && Object.keys(mod.contributors).length) {
    var desc_contributors = "# Contributors";
    for (contributor in mod.contributors) {
      if (
        mod.contributors.hasOwnProperty(contributor) &&
        mod.contributors[contributor]
      )
        desc_contributors += `\n - ${contributor}:\t${mod.contributors[contributor]}`;
    }
    desc_parts.push(desc_contributors);
  }

  // standard footer (license, bug reports, forum thread)
  if (footer) desc_parts.push(fill(templates.description_footer));

  // add version string
  desc_parts.push(fill(templates.version));

  // change notes for github
  if (changenotes)
    desc_parts.push(
      "# Changenotes\n" +
        mod.changenote
          .split("\n")
          .map((line) => ` - ${line}`)
          .join("\n")
    );

  // join together
  var desc = desc_parts.join("\n\n");

  // convert if needed
  if (format == "steam") return md2bbc(desc);
  if (format == "rimworld") return md2rw(desc);
  if (format == "github") return desc;
}

function md2bbc(text) {
  if (!md2bbc.bbc_parser) md2bbc.bbc_parser = new html2bbcode({});

  var html = md2html(text);
  var bbcode = md2bbc.bbc_parser.feed(html).toString();

  // steam does not support lists.
  // remove [ul] tags, including newline after the tag
  bbcode = bbcode.replace(new RegExp(/\[\/?ul\]\n?/, "g"), "");

  // somwhere in all of this, newlines an paragraphs get lost.
  // as a quick fix, double all newlines and add a newline after closing b tags.
  bbcode = bbcode.replace(
    new RegExp(/\n|(\[\/b\])/, "g"),
    (match) => match + "\n"
  );

  // replace [li] tags
  bbcode = bbcode.replace(new RegExp(/\[li\]/, "g"), " - ");

  // remove [/li] tags
  bbcode = bbcode.replace(new RegExp(/\[\/li\]\n/, "g"), "");

  // remove extra newline after headers
  bbcode = bbcode.replace(new RegExp(/\[\/h1\]\n*/, "g"), "[/h1]\n");
  bbcode = bbcode.replace(new RegExp(/\[\/b\]\n+/, "g"), "[/b]\n");

  if (verbosity > 1) console.log(text, html, bbcode);

  return bbcode;
}

function md2rw(text) {
  var allowedtags = ["size", "size=24", "b", "i"];
  var patterns = [
    ["<strong>", "<b>"],
    ["</strong>", "</b>"],
    ["<em>", "<i>"],
    ["</em>", "</i>"],
    [/<h1 id=".*?">/, "<size=24>"],
    ["</h1>", "</size>"],
    ["<p>", ""],
    ["</p>", "\n"],
    ["&amp;", "&"],
  ];

  // make it html
  var html = md2html(text);

  // replace with rw/unity string html elements, as well as some manual hacks (p -> newline, &)
  for (var i = 0, l = patterns.length; i < l; i++)
    html = html.split(patterns[i][0]).join(patterns[i][1]);

  // and strip all other html elements
  html = striptags(html, allowedtags);
  return html;
}

function md2html(text) {
  return marked(text, { gfm: true, breaks: false, smartypants: true });
}

function getGithubBadges() {
  return createBadge(
    "RimWorld",
    getRimWorldVersion(false, true),
    "brightgreen",
    "http://rimworldgame.com/"
  );
}

function createBadge(
  subject = "",
  status = "",
  color = "brightgreen",
  href,
  options
) {
  // build shields.io url
  var shield =
    "https://img.shields.io/badge/" +
    encodeURIComponent(subject) +
    "-" +
    encodeURIComponent(status) +
    "-" +
    color +
    ".svg";

  if (options) {
    shields += "?";
    url_pars = [];
    for (opt in options) {
      url_pars.push(opt + "=" + options[opt]);
    }
    shields += url_pars.join("&");
  }

  // create the badge
  shield = "![" + subject + " " + status + "](" + shield + ")";

  if (href)
    // wrap the whole thing in a url
    shield = "[" + shield + "](" + href + ")";

  return shield;
}

function getVersionString() {
  if (!mod) getModConfig();

  return mod.version.major + "." + mod.version.minor + "." + mod.version.build;
}

function getRimWorldVersion(alpha, main) {
  var raw = fs.readFileSync(paths.version, "utf-8");
  var version = raw.split(" ")[0];

  if (alpha) return version.split(".")[1];
  if (main) return version.split(".").slice(0, 2).join(".");
  return version.split(".");
}

function getGitInfo() {
  var git = parseGit.sync({ cwd: paths.source, path: ".git/config" });
  var origin = git['remote "origin"'].url;
  // adapt regex to match both https and ssh variants
  var regex = /^(?:https:\/\/|git@)github\.com(?::|\/)(.+?)\/(.+?)\.git$/;
  var parts = origin.match(regex);
  return { user: parts[1], repo: parts[2] };
}

function isModDir(dir) {
  // in order to be a valid mod directory, there should be either a "Defs" and/or "Assemblies" path.
  var defs_dir, assemblies_dir;

  try {
    fs.statSync(path.join(dir, "Defs"));
    defs_dir = true;
  } catch (e) {
    defs_dir = false;
  }
  try {
    fs.statSync(path.join(dir, "Assemblies"));
    assemblies_dir = true;
  } catch (e) {
    assemblies_dir = false;
  }

  return defs_dir || assemblies_dir;
}

function sourceDirName() {
  return paths.source.split(path.sep).last();
}

function filter(file) {
  if (!filter.filters)
    filter.filters = fs
      .readFileSync(path.join(__dirname, "excludes.txt"), "utf-8")
      .split("\n")
      .map((pattern) => new RegExp(escape(pattern.trim()), "i"));

  var match = !filter.filters.some((pattern) => file.match(pattern));
  if (args["--verbosity"] > 1) console.log(file, match);

  return match;
}

function getContributors(contributors = {}) {
  // change contributors array to object with properties
  if (contributors.constructor === Array) {
    tmp = {};
    for (var i = 0, l = contributors.length; i < l; i++) {
      tmp[contributors[i]] = "";
    }
    contributors = tmp;
  }

  // get raw list of authors sorted by their number of commits
  var raw = runGitCommand(["shortlog", "HEAD", "-ns"]);
  // use some regex magic to extract the authors
  // NOTE: Use a .mailmap file in the root repository dir to map obsolete/secondary usernames.
  var pattern = /^\s*\d+\s+(.*)$/gm;
  match = pattern.exec(raw);
  while (match != null) {
    var author = match[1];
    if (author != "Fluffy" && !contributors.hasOwnProperty(author)) {
      // make a rough attempt at filling in their contributions.
      var commits = runGitCommand(
        ["log", `--author="${author}"`, `--pretty="tformat:%s"`],
        false,
        true
      )
        .split("\n")
        .join(", ");
      contributors[author] = commits || "";
      console.log({ author, commits });
    }
    match = pattern.exec(raw);
  }

  return contributors;
}

function getChangeNote() {
  // get change notes.
  let notes = getChangeNotes();

  // filter out nologs
  notes = notes.filter((n) => !n.message.match(/\[nolog\]/));

  return notes
    .map((n) => `${n.date} :: ${n.author} :: ${n.message}`)
    .join("\n");
}

function getChangeNotes() {
  // reset git tags from remote (for when a remote tag was removed).
  if (!getChangeNotes.reset && args["--reset-tag"]) {
    runGitCommand(["fetch", "--prune", "origin", "+refs/tags/*:refs/tags/*"]);
    runGitCommand(["fetch", "--tags"]);
    getChangeNotes.reset = true;
  }

  // get raw log
  var changenote = runGitCommand([
    "log",
    getCurrentGitTag() + "..HEAD",
    "--no-merges",
    '--pretty="tformat:%H || %cI || %aN || %s"',
  ]);

  // replace `"` with `'`
  changenote = changenote.replace(/"/g, "'");

  // split into changenote objects
  notes = changenote
    .split("\n")
    .map((line) => {
      [hash, date, author, message] = line.split("||").map((p) => p.trim());
      date = new moment(date).format("YYYY-MM-DD");
      return {
        repo: mod ? mod.git_repo : undefined,
        hash,
        date,
        author,
        message,
      };
    })
    .filter((n) => n.hash && n.message);

  return notes;
}

function getCurrentGitTag() {
  return runGitCommand(["describe", "--tags", "--abbrev=0"]);
}

function runGitCommand(args, cwd, debug = false) {
  var process = spawn("git", args, {
    cwd: cwd || paths.source,
    encoding: "utf-8",
    shell: true,
  });
  var output = process.stdout.trim();
  if (verbosity || debug)
    console.log({
      gitCommand: {
        cwd: cwd || paths.source,
        args,
        command: `git ${args.join(" ")}`,
        process,
        output: process.output.join("\n"),
      },
    });
  return output;
}

function escape(text) {
  return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

function fill(template) {
  if (template)
    return template.replace(new RegExp(/{(.*?)}/, "g"), function (exp) {
      try {
        return eval(exp);
      } catch (e) {
        fail("Error evaluating expression: " + exp + "\n" + e);
      }
    });
  return "";
}
