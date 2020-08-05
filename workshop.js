const spawn = require("child_process").spawn;
const fs = require("fs");
const path = require("path");
const config = require("./config.json");

async function steamWorkshopUpdate(
  mod,
  changenote,
  description,
  debug = false
) {
  return new Promise((resolve, reject) => {
    try {
      // write changenote and description to file.
      fs.writeFileSync("changenote.txt", changenote, "utf8");
      fs.writeFileSync("description.txt", description, "utf8");

      if (debug) {
        console.log({
          mod,
          changenote: path.resolve("changenote.txt"),
          description: path.resolve("description.txt"),
        });
      }

      // spawn process
      let updater = spawn(
        config.paths.steam_workshop_updater,
        [mod, path.resolve("changenote.txt"), path.resolve("description.txt")],
        { stdio: "inherit" }
      );

      // shut it down
      updater.on("close", (result) => {
        fs.unlinkSync("changenote.txt");
        fs.unlinkSync("description.txt");
        if (result) return reject(result);
        else {
          return resolve();
        }
      });
    } catch (err) {
      console.error(err);
      reject(err);
    }
  });
}

module.exports = steamWorkshopUpdate;
