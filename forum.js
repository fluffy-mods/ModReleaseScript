const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const finder = require("fs-finder");
const xml = require("xml2js");
const merge = require("lodash.merge");
const moment = require("moment");
const forumPostUpdater = require("../TOOLS/ThreadUpdater/index");

const config = require("./config.json");
const template = fs.readFileSync( path.join( __dirname, "forum_post_template.bbcode.mustache" ), "utf8" );
const MAX_SIZE = 20000;

if (require.main === module) {
    updateForumPost(process.argv[2]);
}

async function updateForumPost(customTitle, changeNotes){
    // update list of recent changeNotes
    let notes = await updateChangeNotes( changeNotes );

    // the easy part; set title.
    var date = new Date();
    var content = {};
    if (customTitle)
        content.title = "[1.0][MODLIST] Fluffy's Mods - " + customTitle;

    // the hard part, collect all mod's ModConfig.json.
    var mod_dirs = finder.in( config.paths.current_mods ).findDirectories();
    // var obs_dirs = finder.in( config.paths.obsolete_mods ).findDirectories();
    // mod_dirs = mod_dirs.concat( obs_dirs );
    var mods = await Promise.all( mod_dirs.map( await getModInfo ) );

    // render template
    var body = mustache.render( template, { mods });

    // while we have space, add changenotes.
    if ( body.length < ( MAX_SIZE - 1000 ) ){
        let available = ( MAX_SIZE - 500 ) - body.length;
        let changenotes = "";
        for (let i = 0; i < notes.length; i++ ){
            let note = formatChangeNote( notes[i] );
            if ( ( changenotes.length + note.length ) > available)
                break;
            changenotes += note + "\n";
        }
        body += "\n\nChangenotes:\n[code]\n" + changenotes + "\n[/code]";
    }

    content.message = body;

    // do the update
    await forumPostUpdater( config.forum.user, config.forum.password, config.forum.msg, config.forum.post, content );
    return;
}

async function getModInfo( mod_dir ){
    var about = await readXML( finder.from(mod_dir).findFile("About.xml") );
    var mod = require( finder.from(mod_dir).findFile( "ModConfig.json" ) );
    mod = merge( {}, about.ModMetaData, mod );
    mod.tagline = getTagLine( mod );
    mod.targetVersion = formatTargetVersion( mod.supportedVersions );
    var mtime = moment( fs.statSync( finder.from(mod_dir).findFile("About.xml") ).mtime );
    mod.last_update = mtime.format("MMM Do");
    return mod;
}

function getTagLine( mod ){
    return mod.description.split(/\.|;|:|,|\n/, 1)[0];
}

function formatTargetVersion( versions ){
    // guaranteed to be random.
    return "1.0";

    // NOTE: the current XML package doesn't deal nicely with repeated <li> nodes, so 
    // we only get the first one. Hardcoding 1.0 for now.
}

async function readXML( path_to_xml ){
    return new Promise( (resolve, reject ) => {
        xml.parseString( fs.readFileSync( path_to_xml, "utf8" ), {explicitArray: false}, (err, doc) => {
            if (err)
                return reject( err );
            return resolve( doc );
        })
    });
}

async function updateChangeNotes( changenotes ){
    // read current changenote 
    let notes;
    try {
        notes = JSON.parse( fs.readFileSync( path.join( __dirname, "changenotes.json" ), "utf8" ) );
    } catch ( err ) {
        console.error( err );
        notes = [];
    } finally {
        if (changenotes){
            for (const note of changenotes) {
                // add notes that didn't exist yet.
                if ( !note.message.match( /\[nolog\]/i ) && !notes.find( n => n.hash == note.hash ) )
                    notes.push( note );
            }
        }
        notes.sort( (a, b) => {
            if ( a.date > b.date )
                return -1;
            if ( a.date < b.date )
                return 1;
            return 0;
        });
        fs.writeFileSync( path.join( __dirname, "changenotes.json" ), JSON.stringify( notes, null, 4 ), "utf8" );
    }
    return notes;
}

function formatChangeNote( note ){
    return `${note.date} :: ${note.repo} :: ${note.author} :: ${note.message}`;
}

module.exports = updateForumPost