var {ipcMain, remote, dialog, app} = require('electron');
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var request = require("request");
var appPath = app.getPath('userData');
var AdmZip = require('adm-zip');
var compareVersions = require('compare-versions');

import fileUtils from "./fileUtils";

let ExtensionsFolderName = "Extensions";
let MappingFileLocation = appPath + `/${ExtensionsFolderName}/mapping.json`;

class PackageManager {

  constructor() {
    ipcMain.on('install-component', (event, data) => {
      this.installComponent(data);
    });

    ipcMain.on('sync-components', (event, data) => {
      this.syncComponents(data);
    });
  }

  setWindow(window) {
    this.window = window;
  }

  pathsForComponent(component) {
    let relativePath = `${ExtensionsFolderName}/` + component.content.package_info.identifier;
    return {
      downloadPath: appPath + `/${ExtensionsFolderName}/downloads/` + component.content.name + ".zip",
      relativePath: relativePath,
      absolutePath: appPath + "/" + relativePath
    }
  }

  async installComponent(component) {
    let downloadUrl = component.content.package_info.download_url;
    if(!downloadUrl) {
      return;
    }

    console.log("Installing component", component.content.name, downloadUrl);

    return new Promise((resolve, reject) => {
      
      let callback = (installedComponent, error) => {
        this.window.webContents.send("install-component-complete", {component: installedComponent, error: error});
        resolve();
      }
  
      let paths = this.pathsForComponent(component);
  
      fileUtils.downloadFile(downloadUrl, paths.downloadPath, (error) => {
        if(!error) {
          // Delete any existing content, especially in the case of performing an update
          fileUtils.deleteAppRelativeDirectory(paths.relativePath);
  
          // Extract contents
          this.unzipFile(paths.downloadPath, paths.absolutePath, (err) => {
            if(!err) {
              this.unnestPackageContents(paths.absolutePath, () => {
                // Find out main file
                fileUtils.readJSONFile(paths.absolutePath + "/package.json", (response, error) => {
                  var main;
                  if(response) {
                    if(response.sn) { main = response["sn"]["main"]; }
                    if(response.version) { component.content.package_info.version = response.version; }
                  }
                  if(!main) { main = "index.html"; }
  
                  component.content.local_url = "sn://" + paths.relativePath + "/" + main;
                  callback(component);
  
                  // Update mapping file
                  this.updateMappingObject(component.uuid, paths.relativePath);
                })
              })
            } else {
              // Unzip error
              console.log("Unzip error for", component.content.name);
              callback(component, {tag: "error-unzipping"})
            }
          });
        } else {
          // Download error
          callback(component, {tag: "error-downloading"})
        }
      });
    })
  }

  async getMappingObject() {
    if(this.mappingObject) {
      return this.mappingObject;
    }

    this.mappingObject = new Promise((resolve, reject) => {
      fileUtils.readJSONFile(MappingFileLocation, (response, error) => {
        resolve(response || {});
      })
    })

    return this.mappingObject;
  }

  saveMappingObject() {
    // Debounce saving
    const debounceInterval = 3000;
    if(this.saveMappingTimeout) {
      clearTimeout(this.saveMappingTimeout);
    }

    this.saveMappingTimeout = setTimeout(async () => {
      let mappingObject = await this.getMappingObject();
      return new Promise((resolve, reject) => {
        fs.writeFile(MappingFileLocation, JSON.stringify(mappingObject, null, 2), 'utf8', (err) => {
          if (err) console.log("Mapping file save error:", err);
          resolve();
        });
      })
    }, debounceInterval)
  }

  /*
    Maintains a JSON file which maps component ids to their installation location. This allows us to uninstall components
    when they are deleted and do not have any `content`. We only have their uuid to go by.
   */
  async updateMappingObject(componentId, componentPath) {
    let mappingObject = await this.getMappingObject();
    var obj = mappingObject[componentId] || {};
    obj["location"] = componentPath;
    mappingObject[componentId] = obj;

    this.saveMappingObject();
  }

  syncComponents(components) {
    // Incoming `components` are what should be installed. For every component, check
    // the filesystem and see if that component is installed. If not, install it.

    console.log(`Syncing components: ${components.length}`);

    for(let component of components) {
      if(component.deleted) {
        // Uninstall
        this.uninstallComponent(component);
        continue;
      }

      if(!component.content.package_info) {
        console.log("Package info is null, continuing");
        continue;
      }

      let paths = this.pathsForComponent(component);
      fs.stat(paths.absolutePath, async (err, stats) => {
        var doesntExist = err && err.code === 'ENOENT';
        if(doesntExist || !component.content.local_url) {
          // Doesn't exist, install it
          await this.installComponent(component);
        } else if(!component.content.autoupdateDisabled) {
          // Check for updates
          await this.checkForUpdate(component);
        } else {
          // Already exists or update update disabled
          console.log("Not installing component", component.content.name,  "Already exists?", !doesntExist);
        }
      })
    }
  }

  async checkForUpdate(component) {
    var latestURL = component.content.package_info.latest_url;
    if(!latestURL) {
      console.log("No latest url, skipping update", component.content.name);
      return;
    }

    return new Promise((resolve, reject) => {
      request.get(latestURL, async (error, response, body) => {
        if(response.statusCode == 200) {
          var payload = JSON.parse(body);
          let installedVersion = await this.getInstalledVersionForComponent(component);
          let hasUpdate = payload && payload.version && compareVersions(payload.version, installedVersion) == 1;
          console.log("Checking for update for:", component.content.name, "Latest Version:", payload.version, "Installed Version", installedVersion);
          if(hasUpdate) {
            // Latest version is greater than installed version
            console.log("Downloading new version", payload.download_url);
            component.content.package_info.download_url = payload.download_url;
            component.content.package_info.version = payload.version;
            resolve(this.installComponent(component));
          } else {
            resolve();
          }
        } else {
          resolve();
        }
      })
    })
  }

  async getInstalledVersionForComponent(component) {
    // We check package.json version rather than component.content.package_info.version
    // because we want device specific versions rather than a globally synced value
    let paths = this.pathsForComponent(component);
    let packagePath = path.join(paths.absolutePath, "package.json");
    return new Promise((resolve, reject) => {
      fileUtils.readJSONFile(packagePath, (response, error)  => {
        if(!response) {
          resolve(null);
        } else {
          resolve(response['version']);
        }
      })
    })
  }

  async uninstallComponent(component) {
    console.log("Uninstalling component", component.uuid);
    let mappingObject = await this.getMappingObject();
    if (!mappingObject) {
      // No mapping.json means nothing is installed
      return;
    }

    // Get installation location
    var mapping = mappingObject[component.uuid];
    if(!mapping || !mapping.location) {
      return;
    }

    let location = mapping["location"];
    fileUtils.deleteAppRelativeDirectory(location);

    delete mappingObject[component.uuid];
    return this.saveMappingObject();
  }


  /*
    File/Network Operations
  */

  unzipFile(filePath, dest, callback) {
    console.log("Unzipping file at", filePath, "to", dest);
    fs.readFile(filePath, 'utf8', function (err, data) {
      if(err) {
         console.log("Unzip File Error", err);
         callback(err);
         return;
      }

      var zip = new AdmZip(filePath);
      zip.extractAllTo(dest, true /* overwrite */);
      // fs.unlink(filePath); delete original file
      callback();
    });
  }

  /*
    When downloading archives via GitHub, which will be a common use case, we want to be able to use the automatic "sourcecode.zip"
    file that GitHub generates with new releases. However, when you unzip those, it does not immediately reveal the source, but instead
    nests it in a folder. This function checks to see if the downloaded zip contains only 1 folder, and that folder contains a package.json, and if it does
    moves all that folders contents up by a level.
   */
  unnestPackageContents(directory, callback) {
    // console.log("unnestPackageContents", directory);
    fs.readdir(directory, (err, files) => {
      if(err) {
        callback();
        return;
      }

      if(files.length == 1) {
        var file = files[0];
        var location = path.join(directory, file);
        if(fs.statSync(location).isDirectory()) {
          // Unnest
          fileUtils.copyFolderRecursiveSync(location, directory, false);
          callback();
          return;
        }
      }

      callback();
    });
  }

}

export default new PackageManager();
