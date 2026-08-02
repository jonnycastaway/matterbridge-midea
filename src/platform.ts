import {
  type BasePlatformConfig,
  fan,
  MatterbridgeDynamicPlatform,
  MatterbridgeEndpoint,
  onOffPlugInUnit,
  powerSource,
  type PlatformConfig,
  roomAirConditioner,
  type PlatformMatterbridge,
} from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';
import type { ActionContext } from 'matterbridge/matter';
import { BridgedDeviceBasicInformation, FanControl, OnOff, Thermostat, ThermostatUserInterfaceConfiguration } from 'matterbridge/matter/clusters';

import {
  isLikelyNetworkError,
  MideaCloudClient,
  type MideaAppliance,
  MideaLanDiscovery,
  MideaMode,
  type MideaAcState,
  type MideaCredentialCandidate,
  type MideaDeviceConfig,
  MideaLanAcDevice,
} from './midea-device.js';

/**
 * Describe the plugin configuration consumed by the Midea platform.
 *
 * @property {string | undefined} username Midea cloud username used only for LAN bootstrap.
 * @property {string | undefined} password Midea cloud password used only for LAN bootstrap.
 * @property {number | undefined} polling_interval Polling interval in seconds; values below 10 are clamped to 10.
 * @property {MideaDeviceConfig[] | undefined} devices Stored LAN device configuration.
 */
export type MideaPlatformConfig = BasePlatformConfig & {
  username?: string;
  password?: string;
  polling_interval?: number;
  cloudBackend?: 'auto' | 'msmarthome' | 'netHomePlus';
  devices?: MideaDeviceConfig[];
};

type RegisteredAc = {
  config: MideaDeviceConfig;
  endpoint: MatterbridgeEndpoint;
  fanEndpoint: MatterbridgeEndpoint;
  fanAutoEndpoint: MatterbridgeEndpoint;
  swingVerticalEndpoint: MatterbridgeEndpoint;
  ecoEndpoint: MatterbridgeEndpoint;
  device: MideaLanAcDevice;
  lastSyncedState?: MideaAcState;
  reachable?: boolean;
};

const MANUFACTURER = 'Midea';
const PRODUCT = 'Midea SmartHome Air Conditioner';
const PLUGIN_VERSION = '0.1.19';
const MIN_SETPOINT = 16;
const MAX_SETPOINT = 31;

/**
 * Bridge configured Midea LAN air conditioners into Matterbridge endpoints.
 *
 * The platform registers one room-air-conditioner endpoint plus auxiliary fan and switch endpoints per AC.
 */
export class MideaPlatform extends MatterbridgeDynamicPlatform {
  private cloud?: MideaCloudClient;
  private pollTimer?: NodeJS.Timeout;
  private pendingCloudBootstrap?: NodeJS.Timeout;
  private readonly stateSyncTimers = new Set<NodeJS.Timeout>();
  private readonly registeredAcs = new Map<string, RegisteredAc>();
  private updatingFromCloud = false;
  private applyingConfigChange = false;
  private reloadInProgress = false;
  private pollInProgress = false;
  private stopped = false;

  /**
   * Create the Midea platform and verify the required Matterbridge runtime.
   *
   * @param {PlatformMatterbridge} matterbridge Matterbridge host instance.
   * @param {AnsiLogger} log Matterbridge AnsiLogger instance.
   * @param {MideaPlatformConfig} config Plugin configuration supplied by Matterbridge.
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: MideaPlatformConfig) {
    super(matterbridge, log, config);
    this.config = normalizePlatformConfig(config);

    if (typeof this.verifyMatterbridgeVersion !== 'function' || !this.verifyMatterbridgeVersion('3.9.0')) {
      throw new Error(`matterbridge-midea requires Matterbridge >= 3.9.0. Current version: ${this.matterbridge.matterbridgeVersion}`);
    }

    this.log.info('Initializing matterbridge-midea');
  }

  /**
   * Start the platform, register LAN devices, and defer optional cloud bootstrap.
   *
   * @param {string | undefined} reason Optional Matterbridge start reason.
   * @returns {Promise<void>} Resolves when initial LAN registration has completed.
   */
  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting matterbridge-midea${reason ? ` (${reason})` : ''}`);
    await this.ready;
    this.stopped = false;

    await this.reloadDevices(false, false);
    this.scheduleCloudBootstrap('startup');
  }

  /**
   * Configure the platform after Matterbridge setup and trigger an immediate poll.
   *
   * @returns {Promise<void>} Resolves when configuration and initial poll complete.
   */
  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    await this.pollAll();
  }

  /**
   * Apply updated Matterbridge config and schedule credential bootstrap if credentials are present.
   *
   * @param {PlatformConfig} config Updated Matterbridge platform config.
   * @returns {Promise<void>} Resolves after scheduling reload work.
   */
  override async onConfigChanged(config: PlatformConfig): Promise<void> {
    if (this.applyingConfigChange) {
      this.applyingConfigChange = false;
      return;
    }

    this.config = normalizePlatformConfig(config);
    this.log.info('Midea config changed; scheduling device reload');
    this.scheduleDeviceReload('config change');
  }

  /**
   * Stop polling, clear pending bootstrap work, and unregister devices when configured.
   *
   * @param {string | undefined} reason Optional Matterbridge shutdown reason.
   * @returns {Promise<void>} Resolves when platform shutdown cleanup has completed.
   */
  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`Stopping matterbridge-midea${reason ? ` (${reason})` : ''}`);
    this.stopped = true;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.pendingCloudBootstrap) {
      clearTimeout(this.pendingCloudBootstrap);
      this.pendingCloudBootstrap = undefined;
    }
    for (const timer of this.stateSyncTimers) clearTimeout(timer);
    this.stateSyncTimers.clear();

    this.registeredAcs.clear();
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
  }

  /**
   * Record Matterbridge logger level changes.
   *
   * @param {LogLevel} logLevel New Matterbridge logger level.
   * @returns {Promise<void>} Resolves after logging the level change.
   */
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`Logger level changed to ${logLevel}`);
  }

  private scheduleCloudBootstrap(reason: string): void {
    const username = typeof this.config.username === 'string' ? this.config.username.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    if (!username || !password) return;

    this.scheduleReload(reason, true, true, 1000);
  }

  private scheduleDeviceReload(reason: string): void {
    const username = typeof this.config.username === 'string' ? this.config.username.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    const hasCloudCredentials = Boolean(username && password);
    this.scheduleReload(reason, hasCloudCredentials, hasCloudCredentials, 500);
  }

  private scheduleReload(reason: string, saveAfterBootstrap: boolean, allowCloudBootstrap: boolean, delayMs: number): void {
    if (this.pendingCloudBootstrap) clearTimeout(this.pendingCloudBootstrap);
    this.log.info(`Scheduling Midea reload after ${reason}`);
    this.pendingCloudBootstrap = setTimeout(() => {
      this.pendingCloudBootstrap = undefined;
      void this.reloadDevices(saveAfterBootstrap, allowCloudBootstrap).catch((error: unknown) => {
        this.log.error(`Midea reload failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, delayMs);
  }

  private async reloadDevices(saveAfterBootstrap = false, allowCloudBootstrap = true): Promise<void> {
    if (this.stopped) return;
    if (this.reloadInProgress) {
      this.log.warn('Midea reload already in progress; skipping overlapping reload');
      return;
    }

    this.reloadInProgress = true;
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }

      if (this.registeredAcs.size > 0) {
        await this.unregisterAllDevices();
        this.registeredAcs.clear();
      }
      for (const timer of this.stateSyncTimers) clearTimeout(timer);
      this.stateSyncTimers.clear();

      this.config.devices = this.getConfiguredDevices();
      await this.bootstrapDevices(allowCloudBootstrap);
      if (saveAfterBootstrap) this.saveCurrentConfig();
      await this.discoverDevices();
      this.startPolling();
    } finally {
      this.reloadInProgress = false;
    }
  }

  private saveCurrentConfig(): void {
    this.applyingConfigChange = true;
    this.saveConfig(this.config);
  }

  private async discoverDevices(): Promise<void> {
    await this.clearSelect();
    const devices = this.getConfiguredDevices().filter((device) => normalizeType(device.type) === '0xac' && hasLanCredentials(device));
    this.log.info(`Configured ${devices.length} LAN-ready Midea AC device(s)`);

    for (const deviceConfig of devices) {
      try {
        const device = new MideaLanAcDevice(deviceConfig);
        let initialState: MideaAcState | undefined;
        try {
          initialState = await device.refresh();
        } catch (error) {
          this.log.warn(`[${deviceConfig.name}] Initial LAN refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        const endpoint = await this.createEndpoint(deviceConfig, initialState);
        this.bindEndpoint(endpoint, device);
        const fanEndpoint = await this.createFanEndpoint(deviceConfig, initialState);
        this.bindFanEndpoint(fanEndpoint, device);
        const fanAutoEndpoint = await this.createSwitchEndpoint(deviceConfig, 'Fan Auto', 'fan-auto', initialState?.fanSpeed === 102);
        this.bindSwitchEndpoint(fanAutoEndpoint, device, (value) => device.setFanAuto(value));
        const swingVerticalEndpoint = await this.createSwitchEndpoint(deviceConfig, 'Swing Vertical', 'swing-vertical', initialState ? isSwingVerticalActive(initialState) : false);
        this.bindSwitchEndpoint(swingVerticalEndpoint, device, (value) => device.setSwingVertical(value));
        const ecoEndpoint = await this.createSwitchEndpoint(deviceConfig, 'Eco', 'eco', initialState?.ecoMode ?? false);
        this.bindSwitchEndpoint(ecoEndpoint, device, (value) => device.setEcoMode(value));

        this.setSelectDevice(deviceConfig.id, deviceDisplayName(deviceConfig));
        if (this.validateDevice([deviceConfig.id, deviceDisplayName(deviceConfig), deviceConfig.sn])) {
          await this.registerDevice(endpoint);
          await this.registerDevice(fanEndpoint);
          await this.registerDevice(fanAutoEndpoint);
          await this.registerDevice(swingVerticalEndpoint);
          await this.registerDevice(ecoEndpoint);
          this.registeredAcs.set(deviceConfig.id, { config: deviceConfig, endpoint, fanEndpoint, fanAutoEndpoint, swingVerticalEndpoint, ecoEndpoint, device, reachable: true });
          if (initialState) {
            const registered = this.registeredAcs.get(deviceConfig.id);
            if (registered) await this.syncRegisteredState(registered, initialState);
          }
        }
      } catch (error) {
        this.log.error(`[${deviceConfig.name}] Failed to register Midea AC: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async bootstrapDevices(allowCloudBootstrap = true): Promise<void> {
    const configured = this.getConfiguredDevices().filter(isRealConfiguredDevice);
    this.config.devices = configured;
    if (configured.some(hasLanCredentials)) {
      this.log.info('Using stored Midea LAN credentials from config');
    }

    const username = typeof this.config.username === 'string' ? this.config.username.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';
    const hasCloudCredentials = Boolean(username && password);
    const needsBootstrap =
      configured.length === 0 ||
      configured.some((device) => !hasLanCredentials(device)) ||
      (hasCloudCredentials && configured.some((device) => normalizeType(device.type) === '0xac'));
    if (!needsBootstrap) return;

    if (!allowCloudBootstrap) {
      if (hasCloudCredentials) this.log.info('Midea cloud bootstrap deferred until after plugin startup');
      return;
    }

    if (!username || !password) {
      this.log.error('Midea cloud credentials are required only for first LAN bootstrap; no complete LAN device credentials are stored yet');
      return;
    }

    this.cloud = new MideaCloudClient(username, password);
    await this.cloud.login();

    const cloudAppliances = await this.cloud.listAppliances();
    const cloudAcs = cloudAppliances.filter((appliance) => normalizeType(appliance.type) === '0xac');
    const lanDevices = await new MideaLanDiscovery().discover(8000);
    this.log.info(`Bootstrap found ${cloudAcs.length} cloud AC(s), ${cloudAppliances.length} cloud appliance(s), and ${lanDevices.length} LAN Midea device(s)`);

    const validatedIds = new Set<string>();
    const bootstrapTargets = [...cloudAcs];
    for (const lan of lanDevices) {
      if (normalizeType(lan.type) !== '0xac') continue;
      if (bootstrapTargets.some((appliance) => appliance.id === lan.id || appliance.sn === lan.sn)) continue;
      bootstrapTargets.push({
        id: lan.id,
        name: lan.name,
        sn: lan.sn || lan.id,
        type: lan.type,
        modelNumber: lan.modelNumber,
      });
    }
    for (const configuredDevice of configured) {
      if (normalizeType(configuredDevice.type) !== '0xac') continue;
      if (bootstrapTargets.some((appliance) => appliance.id === configuredDevice.id || appliance.sn === configuredDevice.sn)) continue;
      bootstrapTargets.push(configuredDevice);
    }

    for (const appliance of bootstrapTargets) {
      const existing = configured.find((device) => device.id === appliance.id || device.sn === appliance.sn);
      const lan = lanDevices.find((device) => device.id === appliance.id || device.sn === appliance.sn);
      const next: MideaDeviceConfig = existing ?? {
        id: appliance.id,
        name: appliance.name,
        sn: appliance.sn || appliance.id,
        type: normalizeType(appliance.type),
        ip: '',
        port: 6444,
        version: 3,
        token: '',
        key: '',
      };

      next.name = existing?.name || appliance.name;
      next.sn = appliance.sn || appliance.id;
      next.type = normalizeType(appliance.type);
      if (lan) {
        next.ip = lan.ip;
        next.port = lan.port;
        next.version = lan.version;
      }

      if (hasLanCredentials(next)) {
        try {
          await new MideaLanAcDevice(next).validateAuthentication();
          validatedIds.add(next.id);
          this.log.info(`[${next.name}] Stored LAN credentials validated`);
        } catch (error) {
          this.log.warn(`[${next.name}] Stored LAN credentials failed validation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!validatedIds.has(next.id) && this.cloud) {
        try {
          const candidates = await this.cloud.getTokenKeyCandidates(appliance.id);
          const accepted = await this.selectWorkingCredentials(next, candidates);
          next.token = accepted.token;
          next.key = accepted.key;
          validatedIds.add(next.id);
          this.log.info(`[${next.name}] LAN credentials validated from ${accepted.source}`);
        } catch (error) {
          this.log.error(`[${next.name}] Could not validate token/key from Midea cloud: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!existing) configured.push(next);
      if (hasLanCredentials(next)) {
        this.log.info(`[${next.name}] LAN bootstrap complete at ${next.ip}:${next.port}`);
      } else {
        this.log.warn(`[${next.name}] LAN bootstrap incomplete; ip/token/key are required before cloud can be blocked`);
      }
    }

    this.config.devices = configured;
    const acDevices = configured.filter((device) => normalizeType(device.type) === '0xac');
    if (acDevices.length > 0 && acDevices.every((device) => hasLanCredentials(device) && validatedIds.has(device.id))) {
      this.config.username = '';
      this.config.password = '';
      this.log.info('Midea cloud credentials cleared from config after LAN bootstrap');
    }
  }

  private async selectWorkingCredentials(device: MideaDeviceConfig, candidates: MideaCredentialCandidate[]): Promise<MideaCredentialCandidate> {
    if (candidates.length === 0) throw new Error('No token/key candidates returned');

    const errors: string[] = [];
    for (const candidate of candidates) {
      const testConfig: MideaDeviceConfig = {
        ...device,
        token: candidate.token,
        key: candidate.key,
      };

      if (!isValidIp(testConfig.ip)) return candidate;

      try {
        await new MideaLanAcDevice(testConfig).validateAuthentication();
        return candidate;
      } catch (error) {
        errors.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`No candidate token/key worked over LAN. ${errors.join(' | ')}`);
  }

  private getConfiguredDevices(): MideaDeviceConfig[] {
    return parseMideaDeviceConfigs(this.config.devices);
  }

  private async createEndpoint(appliance: MideaDeviceConfig, state?: MideaAcState): Promise<MatterbridgeEndpoint> {
    const currentTemperature = state?.currentTemperature ?? 23;
    const setpoints = thermostatSetpointsForState(state);
    const fanMode = state ? mideaFanSpeedToMatter(state.power, state.fanSpeed) : FanControl.FanMode.Auto;
    const name = deviceDisplayName(appliance);

    const endpoint = new MatterbridgeEndpoint([roomAirConditioner, powerSource], { id: sanitizeEndpointId(appliance.id) })
      .createDefaultBridgedDeviceBasicInformationClusterServer(name, appliance.sn, this.matterbridge.aggregatorVendorId, MANUFACTURER, PRODUCT, 10000, PLUGIN_VERSION)
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(state?.power ?? false)
      .createDefaultThermostatClusterServer(currentTemperature, setpoints.heating, setpoints.cooling, 0, MIN_SETPOINT, MAX_SETPOINT, MIN_SETPOINT, MAX_SETPOINT)
      .createDefaultThermostatUserInterfaceConfigurationClusterServer(
        ThermostatUserInterfaceConfiguration.TemperatureDisplayMode.Celsius,
        ThermostatUserInterfaceConfiguration.KeypadLockout.NoLockout,
        ThermostatUserInterfaceConfiguration.ScheduleProgrammingVisibility.ScheduleProgrammingPermitted,
      )
      .createDefaultFanControlClusterServer(fanMode, FanControl.FanModeSequence.OffLowMedHighAuto, mideaFanSpeedToPercent(state?.fanSpeed), mideaFanSpeedToPercent(state?.fanSpeed))
      .addRequiredClusters();

    return endpoint;
  }

  private async createFanEndpoint(appliance: MideaDeviceConfig, state?: MideaAcState): Promise<MatterbridgeEndpoint> {
    const fanMode = state ? mideaFanSpeedToMatter(state.power, state.fanSpeed) : FanControl.FanMode.Auto;
    const fanPercent = mideaFanSpeedToPercent(state?.fanSpeed);
    const name = deviceDisplayName(appliance);

    return new MatterbridgeEndpoint([fan, powerSource], { id: `${sanitizeEndpointId(appliance.id)}-fan` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        `${name} Fan`,
        `${appliance.sn}-fan`,
        this.matterbridge.aggregatorVendorId,
        MANUFACTURER,
        `${PRODUCT} Fan`,
        10000,
        PLUGIN_VERSION,
      )
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(state?.power ?? false)
      .createDefaultFanControlClusterServer(fanMode, FanControl.FanModeSequence.OffLowMedHighAuto, fanPercent, fanPercent)
      .addRequiredClusters();
  }

  private async createSwitchEndpoint(appliance: MideaDeviceConfig, label: string, idSuffix: string, initialValue: boolean): Promise<MatterbridgeEndpoint> {
    const name = deviceDisplayName(appliance);

    return new MatterbridgeEndpoint([onOffPlugInUnit, powerSource], { id: `${sanitizeEndpointId(appliance.id)}-${idSuffix}` })
      .createDefaultBridgedDeviceBasicInformationClusterServer(
        `${name} ${label}`,
        `${appliance.sn}-${idSuffix}`,
        this.matterbridge.aggregatorVendorId,
        MANUFACTURER,
        `${PRODUCT} ${label}`,
        10000,
        PLUGIN_VERSION,
      )
      .createDefaultIdentifyClusterServer()
      .createDefaultPowerSourceWiredClusterServer()
      .createDeadFrontOnOffClusterServer(initialValue)
      .addRequiredClusters();
  }

  private bindEndpoint(endpoint: MatterbridgeEndpoint, device: MideaLanAcDevice): void {
    endpoint
      .addCommandHandler('on', async () => {
        await this.runUserCommand(device, () => device.setPower(true));
      })
      .addCommandHandler('off', async () => {
        await this.runUserCommand(device, () => device.setPower(false));
      })
      .subscribeAttribute(OnOff, 'onOff', async (value: boolean, _oldValue: boolean, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setPower(value));
      })
      .subscribeAttribute(Thermostat, 'systemMode', async (value: Thermostat.SystemMode, _oldValue: Thermostat.SystemMode, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setMode(matterModeToMidea(value), value !== Thermostat.SystemMode.Off));
      })
      .subscribeAttribute(Thermostat, 'occupiedCoolingSetpoint', async (value: number, _oldValue: number, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setTargetTemperature(matterTemperatureToCelsius(value)));
      })
      .subscribeAttribute(Thermostat, 'occupiedHeatingSetpoint', async (value: number, _oldValue: number, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setTargetTemperature(matterTemperatureToCelsius(value)));
      })
      .subscribeAttribute(FanControl, 'fanMode', async (value: FanControl.FanMode, _oldValue: FanControl.FanMode, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setFanSpeed(matterFanModeToMidea(value)));
      })
      .subscribeAttribute(FanControl, 'percentSetting', async (value: number | null, _oldValue: number | null, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setFanSpeed(matterFanPercentToMidea(value)));
      });
  }

  private bindFanEndpoint(endpoint: MatterbridgeEndpoint, device: MideaLanAcDevice): void {
    endpoint
      .addCommandHandler('on', async () => {
        await this.runUserCommand(device, () => device.setPower(true));
      })
      .addCommandHandler('off', async () => {
        await this.runUserCommand(device, () => device.setPower(false));
      })
      .subscribeAttribute(OnOff, 'onOff', async (value: boolean, _oldValue: boolean, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setPower(value));
      })
      .subscribeAttribute(FanControl, 'fanMode', async (value: FanControl.FanMode, _oldValue: FanControl.FanMode, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setFanSpeed(matterFanModeToMidea(value)));
      })
      .subscribeAttribute(FanControl, 'percentSetting', async (value: number | null, _oldValue: number | null, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => device.setFanSpeed(matterFanPercentToMidea(value)));
      });
  }

  private bindSwitchEndpoint(endpoint: MatterbridgeEndpoint, device: MideaLanAcDevice, setter: (value: boolean) => Promise<MideaAcState>): void {
    endpoint
      .addCommandHandler('on', async () => {
        await this.runUserCommand(device, () => setter(true));
      })
      .addCommandHandler('off', async () => {
        await this.runUserCommand(device, () => setter(false));
      })
      .subscribeAttribute(OnOff, 'onOff', async (value: boolean, _oldValue: boolean, context: ActionContext) => {
        if (this.shouldIgnoreAttributeWrite(context)) return;
        await this.runUserCommand(device, () => setter(value));
      });
  }

  private shouldIgnoreAttributeWrite(_context: ActionContext): boolean {
    return this.updatingFromCloud;
  }

  private async runUserCommand(device: MideaLanAcDevice, command: () => Promise<MideaAcState>): Promise<void> {
    try {
      const state = await command();
      const registered = this.registeredAcs.get(device.id);
      if (registered) {
        void this.setRegisteredReachable(registered, true);
        this.deferStateSync(registered, state);
      }
    } catch (error) {
      const registered = this.registeredAcs.get(device.id);
      if (registered && isLikelyNetworkError(error)) void this.setRegisteredReachable(registered, false);
      this.log.error(`[${device.name}] LAN command failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private deferStateSync(registered: RegisteredAc, state: MideaAcState): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.stateSyncTimers.delete(timer);
      if (this.stopped || this.registeredAcs.get(registered.config.id) !== registered) return;
      void this.syncRegisteredState(registered, state).catch((error: unknown) => {
        this.log.warn(`[${registered.config.name}] Deferred Matter state sync failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 0);
    this.stateSyncTimers.add(timer);
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const intervalSeconds = Math.max(10, Number(this.config.polling_interval ?? 30));
    this.pollTimer = setInterval(() => {
      void this.pollAll();
    }, intervalSeconds * 1000);
    this.log.info(`Polling Midea LAN every ${intervalSeconds}s`);
  }

  private async pollAll(): Promise<void> {
    if (this.stopped || this.pollInProgress) return;
    this.pollInProgress = true;
    try {
      for (const registeredAc of this.registeredAcs.values()) {
        const { config, device } = registeredAc;
        if (this.stopped) return;
        try {
          const state = await device.refresh();
          const registered = this.registeredAcs.get(config.id);
          if (registered) {
            await this.setRegisteredReachable(registered, true);
            await this.syncRegisteredState(registered, state);
          }
        } catch (error) {
          const registered = this.registeredAcs.get(config.id);
          if (registered && isLikelyNetworkError(error)) await this.setRegisteredReachable(registered, false);
          if (registered?.reachable === false) {
            this.log.debug(`[${config.name}] Poll skipped while unreachable: ${error instanceof Error ? error.message : String(error)}`);
          } else {
            this.log.warn(`[${config.name}] Poll failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    } finally {
      this.pollInProgress = false;
    }
  }

  private async setRegisteredReachable(registered: RegisteredAc, reachable: boolean): Promise<void> {
    if (registered.reachable === reachable) return;
    registered.reachable = reachable;

    const endpoints = [registered.endpoint, registered.fanEndpoint, registered.fanAutoEndpoint, registered.swingVerticalEndpoint, registered.ecoEndpoint];
    await Promise.all(
      endpoints.map(async (endpoint) => {
        try {
          await endpoint.setAttribute(BridgedDeviceBasicInformation, 'reachable', reachable, this.log);
        } catch (error) {
          this.log.debug(`[${registered.config.name}] Failed to update reachable=${reachable}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );

    this.log[reachable ? 'info' : 'warn'](`[${registered.config.name}] Midea LAN device is ${reachable ? 'reachable again' : 'unreachable'}`);
  }

  private async syncRegisteredState(registered: RegisteredAc, state: MideaAcState): Promise<void> {
    const previous = registered.lastSyncedState;
    if (previous && sameAcState(previous, state)) return;

    await this.updateEndpointState(registered.endpoint, state, previous);
    await this.updateFanEndpointState(registered.fanEndpoint, state, previous);
    await this.updateAuxiliaryEndpointState(registered.fanAutoEndpoint, registered.swingVerticalEndpoint, registered.ecoEndpoint, state, previous);
    registered.lastSyncedState = cloneAcState(state);
  }

  private async updateEndpointState(endpoint: MatterbridgeEndpoint, state: MideaAcState, previous?: MideaAcState): Promise<void> {
    this.updatingFromCloud = true;
    try {
      const setpoints = thermostatSetpointsForState(state);
      const previousSetpoints = previous ? thermostatSetpointsForState(previous) : undefined;
      if (!previous || previous.power !== state.power) await endpoint.setAttribute(OnOff, 'onOff', state.power, this.log);
      if (!previous || previous.currentTemperature !== state.currentTemperature) {
        await endpoint.setAttribute(Thermostat, 'localTemperature', celsiusToMatterTemperature(state.currentTemperature), this.log);
      }
      if (!previousSetpoints || previousSetpoints.cooling !== setpoints.cooling) {
        await endpoint.setAttribute(Thermostat, 'occupiedCoolingSetpoint', celsiusToMatterSetpoint(setpoints.cooling), this.log);
      }
      if (!previousSetpoints || previousSetpoints.heating !== setpoints.heating) {
        await endpoint.setAttribute(Thermostat, 'occupiedHeatingSetpoint', celsiusToMatterSetpoint(setpoints.heating), this.log);
      }
      if (!previous || previous.power !== state.power || previous.mode !== state.mode) {
        await endpoint.setAttribute(Thermostat, 'systemMode', mideaModeToMatter(state.power, state.mode), this.log);
      }
      if (!previous || previous.power !== state.power || previous.fanSpeed !== state.fanSpeed) {
        await endpoint.setAttribute(FanControl, 'fanMode', mideaFanSpeedToMatter(state.power, state.fanSpeed), this.log);
        await endpoint.setAttribute(FanControl, 'percentSetting', mideaFanSpeedToPercent(state.fanSpeed), this.log);
        await endpoint.setAttribute(FanControl, 'percentCurrent', mideaFanSpeedToPercent(state.fanSpeed), this.log);
      }
    } finally {
      this.updatingFromCloud = false;
    }
  }

  private async updateFanEndpointState(endpoint: MatterbridgeEndpoint, state: MideaAcState, previous?: MideaAcState): Promise<void> {
    if (previous && previous.power === state.power && previous.fanSpeed === state.fanSpeed) return;

    this.updatingFromCloud = true;
    try {
      const fanPercent = mideaFanSpeedToPercent(state.fanSpeed);
      await endpoint.setAttribute(OnOff, 'onOff', state.power, this.log);
      await endpoint.setAttribute(FanControl, 'fanMode', mideaFanSpeedToMatter(state.power, state.fanSpeed), this.log);
      await endpoint.setAttribute(FanControl, 'percentSetting', fanPercent, this.log);
      await endpoint.setAttribute(FanControl, 'percentCurrent', state.power ? fanPercent : 0, this.log);
    } finally {
      this.updatingFromCloud = false;
    }
  }

  private async updateAuxiliaryEndpointState(
    fanAutoEndpoint: MatterbridgeEndpoint,
    swingVerticalEndpoint: MatterbridgeEndpoint,
    ecoEndpoint: MatterbridgeEndpoint,
    state: MideaAcState,
    previous?: MideaAcState,
  ): Promise<void> {
    this.updatingFromCloud = true;
    try {
      if (!previous || previous.fanSpeed !== state.fanSpeed) await fanAutoEndpoint.setAttribute(OnOff, 'onOff', state.fanSpeed === 102, this.log);
      if (!previous || isSwingVerticalActive(previous) !== isSwingVerticalActive(state)) {
        await swingVerticalEndpoint.setAttribute(OnOff, 'onOff', isSwingVerticalActive(state), this.log);
      }
      if (!previous || previous.ecoMode !== state.ecoMode) await ecoEndpoint.setAttribute(OnOff, 'onOff', state.ecoMode, this.log);
    } finally {
      this.updatingFromCloud = false;
    }
  }
}

/**
 * Normalize a Matterbridge platform config into the Midea-specific shape.
 *
 * Edge cases:
 *  - Non-array `devices` becomes an empty device list
 *  - Invalid device entries are dropped before LAN/cloud processing
 *
 * @param {PlatformConfig} config Updated Matterbridge platform configuration.
 * @returns {MideaPlatformConfig} Midea platform config with validated device entries.
 */
function normalizePlatformConfig(config: PlatformConfig): MideaPlatformConfig {
  return {
    ...config,
    devices: parseMideaDeviceConfigs(Reflect.get(config, 'devices')),
  };
}

/**
 * Parse configured devices from unknown external configuration data.
 *
 * Edge cases:
 *  - Non-array values produce an empty array
 *  - Device placeholders are retained only if their required fields have the right primitive type
 *
 * @param {unknown} value Candidate `devices` config value.
 * @returns {MideaDeviceConfig[]} Validated Midea device config entries.
 */
export function parseMideaDeviceConfigs(value: unknown): MideaDeviceConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isValidMideaDeviceConfig);
}

/**
 * Validate a single Midea device config object.
 *
 * Edge cases:
 *  - Empty token/key are allowed during first cloud bootstrap
 *  - Port must be a finite number in the TCP/UDP port range
 *
 * @param {unknown} value Candidate device config value from config JSON.
 * @returns {boolean} `true` when the value has the required Midea device config shape.
 */
export function isValidMideaDeviceConfig(value: unknown): value is MideaDeviceConfig {
  const record = asUnknownRecord(value);
  if (!record) return false;

  const version = record.version;
  const port = record.port;
  const displayName = record.displayName;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.sn === 'string' &&
    typeof record.type === 'string' &&
    typeof record.ip === 'string' &&
    typeof record.token === 'string' &&
    typeof record.key === 'string' &&
    typeof port === 'number' &&
    Number.isFinite(port) &&
    port >= 1 &&
    port <= 65535 &&
    (version === 2 || version === 3) &&
    (displayName === undefined || typeof displayName === 'string')
  );
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  return value as Record<string, unknown>;
}

function sanitizeEndpointId(value: string): string {
  return `midea-ac-${value.replaceAll(/[^a-zA-Z0-9_-]/g, '')}`;
}

function deviceDisplayName(device: MideaDeviceConfig): string {
  const displayName = typeof device.displayName === 'string' ? device.displayName.trim() : '';
  return displayName || device.name;
}

function sameAcState(left: MideaAcState, right: MideaAcState): boolean {
  return (
    left.power === right.power &&
    left.mode === right.mode &&
    left.targetTemperature === right.targetTemperature &&
    left.currentTemperature === right.currentTemperature &&
    left.fanSpeed === right.fanSpeed &&
    left.swingVertical === right.swingVertical &&
    left.ecoMode === right.ecoMode
  );
}

function cloneAcState(state: MideaAcState): MideaAcState {
  return { ...state };
}

/**
 * Return whether the vertical louvers are actively swinging.
 *
 * Midea retains the swing preference while the AC is off. Matter/HomeKit should
 * expose the effective movement state instead of that dormant preference.
 *
 * @param {MideaAcState} state Current Midea AC state.
 * @returns {boolean} `true` only while the AC is powered and swing is enabled.
 */
export function isSwingVerticalActive(state: MideaAcState): boolean {
  return state.power && state.swingVertical;
}

function hasLanCredentials(device: MideaDeviceConfig): boolean {
  return (
    isRealConfiguredDevice(device) &&
    isValidIp(device.ip) &&
    Number.isFinite(device.port) &&
    device.port >= 1 &&
    device.port <= 65535 &&
    isHexCredential(device.token) &&
    isHexCredential(device.key)
  );
}

function normalizeType(value: string): string {
  const lower = value.toLowerCase();
  return lower.startsWith('0x') ? lower : `0x${lower}`;
}

function isRealConfiguredDevice(device: MideaDeviceConfig): boolean {
  return Boolean(device.id && device.id !== 'id' && device.name && device.name !== 'name' && device.sn && device.sn !== 'sn');
}

function isValidIp(value: string): boolean {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value);
}

function isHexCredential(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && value.length >= 32 && value.length % 2 === 0;
}

/**
 * Convert Celsius to Matter temperature units.
 *
 * Edge cases:
 *  - Non-finite values return 0
 *
 * @param {number} value Temperature in Celsius.
 * @returns {number} Matter temperature in Celsius * 100.
 */
export function celsiusToMatterTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

/**
 * Convert a Celsius setpoint to a Matter integer setpoint.
 *
 * Edge cases:
 *  - Non-finite values return the minimum setpoint
 *  - Fractional Celsius values are rounded to a whole degree
 *
 * @param {number} value Setpoint in Celsius.
 * @returns {number} Matter setpoint in Celsius * 100.
 */
export function celsiusToMatterSetpoint(value: number): number {
  if (!Number.isFinite(value)) return MIN_SETPOINT * 100;
  return Math.round(value) * 100;
}

/**
 * Convert Matter temperature units to a clamped Midea Celsius setpoint.
 *
 * Edge cases:
 *  - Non-finite values fall back to the minimum Midea setpoint
 *  - Values below/above Midea bounds are clamped to 16..31 C
 *
 * @param {number} value Matter temperature in Celsius * 100.
 * @returns {number} Clamped setpoint in Celsius.
 */
export function matterTemperatureToCelsius(value: number): number {
  return clamp(Math.round(value / 100), MIN_SETPOINT, MAX_SETPOINT);
}

function thermostatSetpointsForState(state?: MideaAcState): { heating: number; cooling: number } {
  const target = Math.round(state?.targetTemperature ?? 24);
  if (!state?.power) return { heating: MIN_SETPOINT, cooling: target };
  if (state.mode === MideaMode.Heat) return { heating: target, cooling: MAX_SETPOINT };
  return { heating: MIN_SETPOINT, cooling: target };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function mideaModeToMatter(power: boolean, mode: MideaMode): Thermostat.SystemMode {
  if (!power) return Thermostat.SystemMode.Off;
  if (mode === MideaMode.Cool) return Thermostat.SystemMode.Cool;
  if (mode === MideaMode.Heat) return Thermostat.SystemMode.Heat;
  if (mode === MideaMode.FanOnly) return thermostatSystemMode('FanOnly', 7);
  if (mode === MideaMode.Dry) return thermostatSystemMode('Dry', 8);
  return Thermostat.SystemMode.Auto;
}

function matterModeToMidea(mode: Thermostat.SystemMode): MideaMode {
  if (mode === Thermostat.SystemMode.Cool) return MideaMode.Cool;
  if (mode === Thermostat.SystemMode.Heat) return MideaMode.Heat;
  if (mode === thermostatSystemMode('FanOnly', 7)) return MideaMode.FanOnly;
  if (mode === thermostatSystemMode('Dry', 8)) return MideaMode.Dry;
  return MideaMode.Auto;
}

function thermostatSystemMode(name: string, fallback: number): Thermostat.SystemMode {
  const value = Reflect.get(Thermostat.SystemMode, name);
  return typeof value === 'number' ? value : fallback;
}

function mideaFanSpeedToMatter(power: boolean, speed?: number): FanControl.FanMode {
  if (!power) return FanControl.FanMode.Off;
  if (speed === undefined || speed === 102) return FanControl.FanMode.Auto;
  if (speed <= 33) return FanControl.FanMode.Low;
  if (speed <= 66) return FanControl.FanMode.Medium;
  return FanControl.FanMode.High;
}

function matterFanModeToMidea(mode: FanControl.FanMode): number {
  if (mode === FanControl.FanMode.Off) return 0;
  if (mode === FanControl.FanMode.Low) return 33;
  if (mode === FanControl.FanMode.Medium) return 66;
  if (mode === FanControl.FanMode.High) return 100;
  return 102;
}

/**
 * Convert a Matter fan percent setting to a Midea fan speed.
 *
 * Edge cases:
 *  - null/undefined/non-finite -> 0 (turn fan off)
 *  - >=95% is sent as 100 for high speed
 *
 * @param {number | null | undefined} value Matter fan percent setting (0..100).
 * @returns {number} Midea fan speed (0..100).
 */
export function matterFanPercentToMidea(value: number | null | undefined): number {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return 0;
  const percent = clamp(Math.round(numeric), 0, 100);
  if (percent <= 0) return 0;
  if (percent >= 95) return 100;
  return percent;
}

/**
 * Convert Midea fan speed to a Matter fan percent.
 *
 * Edge cases:
 *  - undefined, <=0, non-finite, or auto speed 102 -> 0
 *  - Manual speed values are clamped to 1..100
 *
 * @param {number | undefined} speed Midea fan speed (0..102, where 102 means auto).
 * @returns {number} Matter fan percent (0..100).
 */
export function mideaFanSpeedToPercent(speed?: number): number {
  if (speed !== undefined && !Number.isFinite(speed)) return 0;
  if (speed === undefined || speed <= 0 || speed === 102) return 0;
  return clamp(Math.round(speed), 1, 100);
}
