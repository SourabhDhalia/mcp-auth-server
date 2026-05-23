// SPDX-License-Identifier: Apache-2.0

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type { BridgesRegistryData, EndpointConfig, ManagedBridge } from "../types.js";

export class BridgesRegistry {
    private registry: BridgesRegistryData;
    private readonly registryPath: string;

    constructor(registryPath: string = "./data/bridges-config.json") {
        this.registryPath = resolve(process.cwd(), registryPath);
        this.registry = this.loadRegistry();
    }

    /**
     * Load or create the bridges registry from disk
     */
    private loadRegistry(): BridgesRegistryData {
        if (existsSync(this.registryPath)) {
            try {
                const content = readFileSync(this.registryPath, "utf8");
                return JSON.parse(content) as BridgesRegistryData;
            } catch (error) {
                console.error(
                    `Failed to load bridges registry from ${this.registryPath}:`,
                    error,
                );
                return this.createDefaultRegistry();
            }
        }

        return this.createDefaultRegistry();
    }

    /**
     * Create a default registry with Swiggy as the initial bridge
     */
    private createDefaultRegistry(): BridgesRegistryData {
        return {
            version: "1.0.0",
            bridges: [
                {
                    bridgeId: "swiggy",
                    bridgeName: "Swiggy MCP",
                    providerName: "Swiggy",
                    oauthScope: "mcp:tools mcp:resources mcp:prompts",
                    endpoints: [
                        {
                            key: "food",
                            name: "Swiggy Food",
                            url: process.env.SWIGGY_FOOD_URL || "https://mcp.swiggy.com/food",
                        },
                        {
                            key: "instamart",
                            name: "Swiggy Instamart",
                            url:
                                process.env.SWIGGY_INSTAMART_URL || "https://mcp.swiggy.com/im",
                        },
                        {
                            key: "dineout",
                            name: "Swiggy Dineout",
                            url:
                                process.env.SWIGGY_DINEOUT_URL ||
                                "https://mcp.swiggy.com/dineout",
                        },
                    ],
                    enabled: true,
                    createdAt: new Date().toISOString(),
                },
            ],
            lastUpdated: new Date().toISOString(),
        };
    }

    /**
     * Save registry to disk
     */
    private saveRegistry(): void {
        mkdirSync(dirname(this.registryPath), { recursive: true });
        this.registry.lastUpdated = new Date().toISOString();
        writeFileSync(
            this.registryPath,
            JSON.stringify(this.registry, null, 2),
            "utf8",
        );
    }

    /**
     * Get all bridges
     */
    getBridges(): ManagedBridge[] {
        return this.registry.bridges;
    }

    /**
     * Get enabled bridges only
     */
    getEnabledBridges(): ManagedBridge[] {
        return this.registry.bridges.filter((b) => b.enabled);
    }

    /**
     * Get a single bridge by ID
     */
    getBridge(bridgeId: string): ManagedBridge | undefined {
        return this.registry.bridges.find((b) => b.bridgeId === bridgeId);
    }

    /**
     * Check if a bridge ID already exists
     */
    bridgeExists(bridgeId: string): boolean {
        return this.registry.bridges.some((b) => b.bridgeId === bridgeId);
    }

    /**
     * Validate bridge configuration
     */
    private validateBridge(bridge: Partial<ManagedBridge>): string[] {
        const errors: string[] = [];

        if (!bridge.bridgeId || !/^[a-z0-9\-]+$/.test(bridge.bridgeId)) {
            errors.push("Bridge ID must contain only lowercase letters, numbers, and hyphens");
        }

        if (!bridge.bridgeName || bridge.bridgeName.trim().length === 0) {
            errors.push("Bridge name is required");
        }

        if (!bridge.providerName || bridge.providerName.trim().length === 0) {
            errors.push("Provider name is required");
        }

        if (!bridge.endpoints || bridge.endpoints.length === 0) {
            errors.push("At least one endpoint is required");
        }

        if (bridge.endpoints) {
            bridge.endpoints.forEach((endpoint, idx) => {
                if (!endpoint.name || endpoint.name.trim().length === 0) {
                    errors.push(`Endpoint ${idx + 1}: name is required`);
                }
                if (!endpoint.url || endpoint.url.trim().length === 0) {
                    errors.push(`Endpoint ${idx + 1}: url is required`);
                }
                try {
                    new URL(endpoint.url);
                } catch {
                    errors.push(`Endpoint ${idx + 1}: url is not a valid URL`);
                }
            });
        }

        return errors;
    }

    /**
     * Add a new bridge
     */
    addBridge(config: {
        bridgeId: string;
        bridgeName: string;
        providerName: string;
        oauthScope?: string;
        endpoints: EndpointConfig[];
    }): { success: boolean; error?: string; bridge?: ManagedBridge } {
        // Check if bridge already exists
        if (this.bridgeExists(config.bridgeId)) {
            return { success: false, error: `Bridge with ID "${config.bridgeId}" already exists` };
        }

        // Validate bridge configuration
        const errors = this.validateBridge(config);
        if (errors.length > 0) {
            return { success: false, error: errors.join("; ") };
        }

        // Create new bridge
        const newBridge: ManagedBridge = {
            bridgeId: config.bridgeId,
            bridgeName: config.bridgeName,
            providerName: config.providerName,
            oauthScope: config.oauthScope || "mcp:tools mcp:resources mcp:prompts",
            endpoints: config.endpoints.map((ep) => ({
                key: ep.key || ep.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                name: ep.name,
                url: ep.url,
            })),
            enabled: true,
            createdAt: new Date().toISOString(),
        };

        this.registry.bridges.push(newBridge);
        this.saveRegistry();

        return { success: true, bridge: newBridge };
    }

    /**
     * Update an existing bridge
     */
    updateBridge(bridgeId: string, updates: Partial<ManagedBridge>): { success: boolean; error?: string } {
        const bridge = this.getBridge(bridgeId);
        if (!bridge) {
            return { success: false, error: `Bridge "${bridgeId}" not found` };
        }

        // Validate if updating endpoints
        if (updates.endpoints) {
            const errors = this.validateBridge({ ...bridge, ...updates });
            if (errors.length > 0) {
                return { success: false, error: errors.join("; ") };
            }
        }

        Object.assign(bridge, updates);
        this.saveRegistry();

        return { success: true };
    }

    /**
     * Delete a bridge
     */
    deleteBridge(bridgeId: string): { success: boolean; error?: string } {
        const index = this.registry.bridges.findIndex((b) => b.bridgeId === bridgeId);
        if (index === -1) {
            return { success: false, error: `Bridge "${bridgeId}" not found` };
        }

        this.registry.bridges.splice(index, 1);
        this.saveRegistry();

        return { success: true };
    }

    /**
     * Enable/disable a bridge
     */
    setBridgeEnabled(bridgeId: string, enabled: boolean): { success: boolean; error?: string } {
        const bridge = this.getBridge(bridgeId);
        if (!bridge) {
            return { success: false, error: `Bridge "${bridgeId}" not found` };
        }

        bridge.enabled = enabled;
        this.saveRegistry();

        return { success: true };
    }

    /**
     * Get registry path (for logging/debugging)
     */
    getRegistryPath(): string {
        return this.registryPath;
    }

    /**
     * Reload registry from disk
     */
    reload(): void {
        this.registry = this.loadRegistry();
    }
}
