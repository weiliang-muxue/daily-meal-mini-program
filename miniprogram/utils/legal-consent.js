'use strict'

// This is the app's agreement version, separate from WeChat's native permission.
// Keep read/checkbox state in the access page only; never restore it from storage.
const LEGAL_CONSENT_VERSION = 2

function hasCurrentLegalConsent(member) {
  return Boolean(member && member.status === 'active'
    && member.legalConsentVersion === LEGAL_CONSENT_VERSION
    && member.legalConsentAccepted === true)
}

function legalConsentPayload(value) {
  if (!value || value.version !== LEGAL_CONSENT_VERSION
    || value.privacyRead !== true || value.agreementRead !== true || value.accepted !== true) return null
  return { version: LEGAL_CONSENT_VERSION, privacyRead: true, agreementRead: true, accepted: true }
}

module.exports = { LEGAL_CONSENT_VERSION, hasCurrentLegalConsent, legalConsentPayload }
