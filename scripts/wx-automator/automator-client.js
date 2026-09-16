'use strict'

const automator = require('miniprogram-automator')
const {
  connectAutomator,
  getAutomatorEndpoint,
  launchAutomator,
} = require('./automation-runtime')

module.exports = {
  connect(options = {}) {
    return connectAutomator(automator, {
      ...options,
      wsEndpoint: getAutomatorEndpoint(),
    })
  },
  getEndpoint: getAutomatorEndpoint,
  launch(options = {}) {
    return launchAutomator(automator, options)
  },
}
