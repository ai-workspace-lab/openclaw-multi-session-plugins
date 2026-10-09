export declare function lastAssistantText(messages: unknown): string | undefined;
declare const plugin: Omit<{
    id: string;
    name: string;
    description: string;
    kind?: import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["kind"];
    configSchema?: import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema | (() => import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema);
    reload?: import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["reload"];
    nodeHostCommands?: import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["nodeHostCommands"];
    securityAuditCollectors?: import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["securityAuditCollectors"];
    register: NonNullable<import("openclaw/plugin-sdk/core").OpenClawPluginDefinition["register"]>;
}, "configSchema"> & {
    configSchema: import("openclaw/plugin-sdk/core").OpenClawPluginConfigSchema;
};
export default plugin;
