/*
 * @Author: your name
 * @Date: 2021-12-26 07:37:42
 * @LastEditTime: 2022-01-01 05:04:28
 * @LastEditors: your name
 * @Description: 打开koroFileHeader查看配置 进行设置: https://github.com/OBKoro1/koro1FileHeader/wiki/%E9%85%8D%E7%BD%AE
 * @FilePath: \pxrepo\src\protocol\config.js
 */
const Fs = require('fs-extra')
const Path = require('path')

const CONFIG_FILE_DIR = require('appdata-path').getAppDataPath('pxrepo')
const CONFIG_FILE = Path.resolve(CONFIG_FILE_DIR, 'protocol.json')

const writeConfig = (config = { registered: false, port: 0 }) => {
    Fs.ensureDirSync(CONFIG_FILE_DIR)
    Fs.writeJsonSync(CONFIG_FILE, config)
    return config
}

const readConfig = () => Fs.readJsonSync(CONFIG_FILE)

const getConfig = () => {
    try {
        return readConfig()
    } catch (error) {
        return writeConfig()
    }
}

const data = getConfig()

module.exports = {
    data,
    modify: obj => writeConfig(Object.assign(data, obj)),
}