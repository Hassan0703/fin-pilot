/**
 * FinPilot v0 — Authentication.
 *
 * Static API token stored as SHA-256 in settings.api_token_hash.
 * Empty hash = development mode (open API). Never store the raw token.
 */

var AuthService = {
  /** @return {boolean} */
  authorize: function (candidate) {
    var expectedHash = SettingsService.getRaw("api_token_hash");
    if (!expectedHash) return true; // development mode
    if (!candidate) return false;
    var candidateHash = AuthService.hash(String(candidate));
    return candidateHash === expectedHash;
  },

  hash: function (input) {
    var digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, String(input), Utilities.Charset.UTF_8);
    return digest.map(function (b) {
      var hex = (b < 0 ? b + 256 : b).toString(16);
      return hex.length === 1 ? "0" + hex : hex;
    }).join("");
  },

  /** Sets or rotates the token. Returns a masked confirmation only. */
  rotateToken: function (rawToken) {
    if (!rawToken || rawToken.length < 12) {
      throw new Error("Token must be at least 12 characters.");
    }
    SettingsService.set("api_token_hash", AuthService.hash(rawToken), "STRING",
      "SHA-256 hash of the API bearer token.", true);
  }
};
