// SPDX-License-Identifier: Apache-2.0

export interface EndpointConfig {
    key: string;
    name: string;
    url: string;
}

export interface ManagedBridge {
    bridgeId: string;
    bridgeName: string;
    providerName: string;
    oauthScope: string;
    endpoints: EndpointConfig[];
    enabled: boolean;
    createdAt: string;
}

export interface BridgesRegistryData {
    version: string;
    bridges: ManagedBridge[];
    lastUpdated: string;
}
