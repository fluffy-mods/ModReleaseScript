#!/usr/bin/env node
`use strict`;

const { docopt } = require("docopt");
const Github = require("github");
const Git = require("simple-git/promise");
const path = require("path");
const fs = require("mz/fs");

const gittoken = require("./git_token");
const docstring = `Usage:
    rw-release init <name> <description> [options]
    rw-release create <version> [options]
    rw-release use <version> [options]
    
Options:
    -h, --help              Show usage information
    -d, --debug             Run in debug mode?`;

const args = docopt(docstring, {});
const debug = args["--debug"];
const version = args["<version>"];
const name = args["<name>"];
const description = args["<description>"];
const { create, use, init } = args;
if (debug) console.log({ args });

if (create) {
  doCreate(version);
} else if (use) {
  doUse(version);
} else if (init) {
  doInit(name, description);
}

async function doInit(name, description) {
  // create repo
  const github = new Github();
  github.authenticate({ type: "token", token: gittoken });

  try {
    const repo = await github.repos.createForOrg({
      org: "fluffy-mods",
      name: name.replace(/\s/g, ""),
      description,
    });
    console.log(`Created ${repo.clone_url}.`);

    // initialize git and create first commit
    const git = Git(process.cwd());
    await git.init();
    await git.add(".");
    await git.commit("initial commit");
    console.log("Created initial commit.");

    // add remote
    await git.remote(["add", "origin", repo.clone_url]);
    console.log("Added remote.");
  } catch (err) {
    console.error(
      `Failed to initialize version control for '${name}':\n${err}`
    );
  }
}

async function doCreate(version) {
  let folders = await getGitFolders();
  for (let folder of folders) {
    try {
      const git = Git(folder);
      await git.checkoutLocalBranch(version);
      await git.push("origin", version, { "--set-upstream": true });
      console.log(`Created branch ${verison} for ${folder}.`);
    } catch (err) {
      console.error(
        `Failed to create branch '${version}' for '${folder}': \n${err}`
      );
    }
  }
}

async function doUse(version) {
  let folders = await getGitFolders();
  let github = new Github();
  github.authenticate({ type: "token", token: gittoken });

  for (let folder of folders) {
    try {
      const git = Git(folder);
      if (!(await git.branch()).all.includes(version)) await doCreate(version);
      const remote = (await git.getRemotes(true)).find(
        (r) => r.name == "origin"
      );
      const { owner, repo } = remote.refs.push.match(
        /https?:\/\/github.com\/(?<owner>.+)\/(?<repo>.+)\.git/
      ).groups;
      await github.repos.edit({
        owner,
        repo,
        name: repo,
        default_branch: version,
      });
      console.log(`Branch ${version} set as default branch for ${folder}.`);
    } catch (err) {
      console.error(
        `Failed to make branch '${version}' the default for '${folder}': \n${err}`
      );
    }
  }
}

async function getGitFolders() {
  const contents = await fs.readdir(process.cwd());
  return [process.cwd(), ...contents]
    .filter((s) => fs.statSync(s).isDirectory())
    .filter((d) => {
      try {
        fs.statSync(path.join(d, ".git"));
        return true;
      } catch (err) {
        // console.error( d, err );
        return false;
      }
    });
}
