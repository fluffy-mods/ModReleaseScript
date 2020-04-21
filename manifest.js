const doManifestUpdate = require("../TOOLS/ManifestUpdater");

async function manifestUpdate(mod, path, version, targetVersion) {
  // build manifest and download urls
  let content = {
    Manifest: {
      version: version,
      manifestUri: `https://raw.githubusercontent.com/${mod.git_user}/${mod.git_repo}/${targetVersion}/About/Manifest.xml`,
      downloadUri: `https://github.com/${mod.git_user}/${mod.git_repo}/releases/v${version}`,
    },
  };
  return await doManifestUpdate(path, content);
}

module.exports = manifestUpdate;
