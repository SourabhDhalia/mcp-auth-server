import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

interface PersistedOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly persistedState: PersistedOAuthState;
  private lastAuthorizationUrl?: URL;

  constructor(
    private readonly filePath: string,
    private readonly redirectTarget: string | URL,
    private readonly metadata: OAuthClientMetadata,
    private readonly onRedirect?: (url: URL) => void,
    public readonly clientMetadataUrl?: string,
  ) {
    this.persistedState = this.loadState();
  }

  get redirectUrl(): string | URL {
    return this.redirectTarget;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.metadata;
  }

  authorizationUrl(): URL | undefined {
    return this.lastAuthorizationUrl;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.persistedState.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.persistedState.clientInformation = clientInformation;
    this.persist();
  }

  tokens(): OAuthTokens | undefined {
    return this.persistedState.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.persistedState.tokens = tokens;
    this.persist();
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.lastAuthorizationUrl = authorizationUrl;
    this.onRedirect?.(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.persistedState.codeVerifier = codeVerifier;
    this.persist();
  }

  codeVerifier(): string {
    if (!this.persistedState.codeVerifier) {
      throw new Error("No PKCE code verifier is stored for the current auth flow.");
    }

    return this.persistedState.codeVerifier;
  }

  private loadState(): PersistedOAuthState {
    if (!existsSync(this.filePath)) {
      return {};
    }

    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedOAuthState;
    } catch {
      return {};
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      JSON.stringify(this.persistedState, null, 2),
      "utf8",
    );
  }
}
