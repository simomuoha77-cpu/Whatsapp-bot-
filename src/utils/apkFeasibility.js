'use strict';
/**
 * Rule-based feasibility analysis for a plain-language customization request.
 * Deterministic on purpose (no AI in Phase 1). Nothing here edits an APK.
 *
 * `buildAvailable` is false for every operation until the isolated build server exists
 * (Phase 2); the report says so instead of pretending a build is possible.
 */

const BUILD_SERVER_AVAILABLE = false;

const RULES = [
  {
    id: 'bypass_protection', feasibility: 'not_permitted',
    test: /\b(crack(ed)?|bypass|unlock (premium|pro|paid)|premium|pro version|paywall|remove (the )?ads?|ad[- ]?free|disable (the )?ads?|subscription|license (check|key)|licen[cs]e|drm|patch(ed)? (the )?(app|apk)|free coins|unlimited (coins|gems|money))\b/i,
    change: 'Remove ads, unlock premium features, or bypass licensing or subscription checks',
    reason: 'Bypassing third-party access controls, advertising, subscriptions, DRM or licence enforcement is not permitted in this tool.',
    risk: 'Legal exposure and likely Play Protect or store enforcement.',
    action: 'None. Use the app\'s official configuration, or modify only apps you own or have written permission to modify.',
  },
  {
    id: 'package_name', feasibility: 'requires_manual_review',
    test: /\b(package (name|id|identifier)|application ?id|bundle id)\b/i,
    change: 'Change the package name / application ID',
    reason: 'The package name is referenced in code, manifest entries, deep links and third-party services (Firebase, Google sign-in, payments). A rename can silently break these.',
    risk: 'Breaks integrations; installs as a different app, so it cannot update the original.',
    action: 'Manual review by an engineer who can check which services depend on the identifier.',
  },
  {
    id: 'logic_change', feasibility: 'unsupported',
    test: /\b(add|remove|enable|disable|change|modify|fix|replace|new|implement|integrate)\b[^.\n]{0,60}\b(feature|function(ality)?|logic|screen|page|button|menu|login|payment|api|server|url|endpoint|behaviou?r|code|notification|permission)s?\b/i,
    change: 'Change features, behaviour or application logic',
    reason: 'Compiled app code can\'t be reliably rewritten from an APK alone. It would need source code, or substantial reverse engineering that this tool does not implement.',
    risk: 'Crashes, corrupted behaviour, and a modified app whose effects can\'t be verified.',
    action: 'Not available. If you have the project source code, change it there and rebuild; a source-based build is out of scope for this module.',
  },
  {
    id: 'rename', feasibility: 'conditionally_supported', op: 'update_label',
    test: /\b(rename|app(lication)? name|change (the )?(app )?name|display name|app label|app title|call (it|the app))\b/i,
    change: 'Change the app\'s display name',
    reasonFn: (a) => a && a.manifest && a.manifest.labelIsReference
      ? 'The name is stored as a compiled resource reference (' + (a.manifest.labelRef || 'resource') + '). Changing it means editing resources.arsc on the build server, which can fail for obfuscated or protected resources.'
      : 'The name appears to be stored directly in the manifest, which is simpler to change, but it still requires repackaging and re-signing.',
    risk: 'Repackaging invalidates the original signature. The result must be re-signed.',
    action: 'Update the app label resource, repackage, sign, then verify the output.',
  },
  {
    id: 'icon', feasibility: 'conditionally_supported', op: 'replace_icon',
    test: /\b(icon|logo|launcher|app image|branding)\b/i,
    change: 'Replace the launcher icon / logo',
    reason: 'Possible when the icon is a plain image resource. Adaptive icons, icons referenced from code, or protected resources may need manual review.',
    risk: 'Repackaging invalidates the original signature. A wrong image size or shape can render badly on some devices.',
    action: 'Replace the icon image resources at the required densities, repackage, sign, then verify.',
  },
  {
    id: 'visual', feasibility: 'conditionally_supported', op: 'change_visual_resources',
    test: /\b(colou?rs?|theme|splash( screen)?|background|font|style|appearance|look)\b/i,
    change: 'Change colours or other visual resources',
    reason: 'Only static colour or style resources can be changed. Colours set in code, or from a remote server, are out of reach.',
    risk: 'Low contrast or partially applied themes. The original signature is invalidated.',
    action: 'Change supported colour and style resources, repackage, sign, then verify.',
  },
  {
    id: 'diagnostic', feasibility: 'supported', op: 'diagnostic_report', availableNow: true,
    test: /\b(inspect|analy[sz]e|analysis|report|checksum|hash|verify|verification|diagnos|metadata|permissions?|signature|certificate|what('s| is) (in|inside))\b/i,
    change: 'Inspect the APK and produce a diagnostic report',
    reason: 'Available now: metadata, permissions, signing information and structure are shown on the project page.',
    risk: 'None. The APK is only read, never run or altered.',
    action: 'See the analysis on this project page.',
  },
];

const GENERAL_RISKS = [
  'Any modification invalidates the original signature, so the output has to be re-signed.',
  'If the new signing certificate differs from the installed app\'s certificate, Android will not install it as an update. The user would need to uninstall the old version first, which can remove local app data.',
];

function buildFeasibilityReport(description, analysis) {
  const text = String(description || '').trim().slice(0, 4000);
  const items = [];
  const seen = new Set();
  for (const rule of RULES) {
    if (!rule.test.test(text) || seen.has(rule.id)) continue;
    seen.add(rule.id);
    const supportedNow = !!rule.availableNow;
    items.push({
      id: rule.id,
      operation: rule.op || null,
      requestedChange: rule.change,
      feasibility: rule.feasibility,
      reason: rule.reasonFn ? rule.reasonFn(analysis) : rule.reason,
      risk: rule.risk,
      proposedAction: rule.action,
      approvalRequired: rule.feasibility === 'conditionally_supported',
      buildAvailable: supportedNow ? true : (rule.feasibility === 'conditionally_supported' && BUILD_SERVER_AVAILABLE),
    });
  }
  if (!items.length) {
    items.push({
      id: 'unmapped', operation: null, requestedChange: text ? 'Your request' : 'No request text provided',
      feasibility: 'requires_manual_review',
      reason: 'The request could not be matched to any implemented operation. Nothing will be substituted automatically.',
      risk: 'Unknown.', proposedAction: 'Rephrase using one of the supported operations: change app name, replace icon, change colours, or inspect/report.',
      approvalRequired: false, buildAvailable: false,
    });
  }
  const buildableNow = items.filter((i) => i.buildAvailable && i.operation !== 'diagnostic_report').length;
  return {
    items,
    generalRisks: GENERAL_RISKS,
    buildServerAvailable: BUILD_SERVER_AVAILABLE,
    summary: BUILD_SERVER_AVAILABLE
      ? (buildableNow ? 'Some requested changes can be built after you approve the plan.' : 'No requested change can be built.')
      : 'Customization builds are not available yet: the isolated build server has not been set up. This plan is recorded for later; nothing was modified.',
  };
}

module.exports = { buildFeasibilityReport, BUILD_SERVER_AVAILABLE };
