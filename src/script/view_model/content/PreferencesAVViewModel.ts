/*
 * Wire
 * Copyright (C) 2018 Wire Swiss GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see http://www.gnu.org/licenses/.
 *
 */

import ko from 'knockout';
import {getLogger, Logger} from 'Util/Logger';
import {Environment} from 'Util/Environment';
import {Config, Configuration} from '../../Config';
import {MediaType} from '../../media/MediaType';
import {MediaError} from '../../error/MediaError';
import {MediaRepository} from '../../media/MediaRepository';
import {MediaStreamHandler} from '../../media/MediaStreamHandler';
import {MediaConstraintsHandler} from '../../media/MediaConstraintsHandler';
import {UserRepository} from '../../user/UserRepository';
import {Call} from '../../calling/Call';
import {MediaDevicesHandler, Devices, DeviceIds, DeviceSupport} from '../../media/MediaDevicesHandler';

type MediaSourceChanged = (mediaStream: MediaStream, mediaType: MediaType, call?: Call) => void;
type WillChangeMediaSource = (mediaType: MediaType) => boolean;
type CallBacksType = {
  mediaSourceChanged: MediaSourceChanged;
  willChangeMediaSource: WillChangeMediaSource;
};

export class PreferencesAVViewModel {
  audioContext: AudioContext;
  audioInterval: number;
  audioLevel: ko.Observable<number>;
  audioMediaStream: ko.PureComputed<MediaStream>;
  audioSource: MediaStreamAudioSourceNode;
  availableDevices: Devices;
  brandName: string;
  Config: Configuration;
  constraintsHandler: MediaConstraintsHandler;
  currentDeviceId: DeviceIds;
  currentMediaType: MediaType;
  devicesHandler: MediaDevicesHandler;
  deviceSupport: DeviceSupport;
  isActivatedAccount: ko.PureComputed<boolean>;
  isTemporaryGuest: ko.PureComputed<boolean>;
  isVisible: boolean;
  logger: Logger;
  mediaSourceChanged: MediaSourceChanged;
  mediaStream: ko.Observable<MediaStream>;
  streamHandler: MediaStreamHandler;
  supportsAudioOutput: ko.PureComputed<boolean>;
  userRepository: UserRepository;
  videoMediaStream: ko.PureComputed<MediaStream>;
  willChangeMediaSource: WillChangeMediaSource;

  static get CONFIG() {
    return {
      AUDIO_METER: {
        FFT_SIZE: 1024,
        INTERVAL: 100,
        LEVEL_ADJUSTMENT: 0.075,
        SMOOTHING_TIME_CONSTANT: 0.2,
      },
    };
  }

  constructor(mediaRepository: MediaRepository, userRepository: UserRepository, callbacks: CallBacksType) {
    this.willChangeMediaSource = callbacks.willChangeMediaSource;
    this.mediaSourceChanged = callbacks.mediaSourceChanged;

    this.logger = getLogger('PreferencesAVViewModel');

    this.userRepository = userRepository;

    this.isActivatedAccount = this.userRepository.isActivatedAccount;

    this.devicesHandler = mediaRepository.devicesHandler;
    this.availableDevices = this.devicesHandler.availableDevices;
    this.currentDeviceId = this.devicesHandler.currentDeviceId;
    this.deviceSupport = this.devicesHandler.deviceSupport;
    this.Config = Config.getConfig();

    const updateStream = async (mediaType: MediaType): Promise<void> => {
      this.currentMediaType = mediaType;
      this._releaseAudioMeter();
      const needsStreamUpdate = this.willChangeMediaSource(mediaType);
      if (this.mediaStream()) {
        this.streamHandler.releaseTracksFromStream(this.mediaStream(), mediaType);
      }
      if (!needsStreamUpdate && !this.mediaStream()) {
        return undefined;
      }

      try {
        const stream = await this._getMediaStream(mediaType);
        if (typeof stream === 'boolean') {
          return this.mediaStream(undefined);
        }
        this.mediaSourceChanged(stream, mediaType);
        if (this.mediaStream()) {
          stream.getTracks().forEach(track => {
            this.mediaStream().addTrack(track);
          });
          this._initiateAudioMeter(this.mediaStream());
        } else {
          stream.getTracks().forEach(track => track.stop());
        }
      } catch (error) {
        this.logger.warn(`Requesting MediaStream failed: ${error.message}`, error);
      }
    };

    this.currentDeviceId.audioInput.subscribe(() => updateStream(MediaType.AUDIO));
    this.currentDeviceId.videoInput.subscribe(() => updateStream(MediaType.VIDEO));

    this.constraintsHandler = mediaRepository.constraintsHandler;
    this.streamHandler = mediaRepository.streamHandler;

    const createMediaStreamOfType = (tracksGetter: 'getAudioTracks' | 'getVideoTracks') => {
      const tracks = this.mediaStream() && this.mediaStream()[tracksGetter]();
      if (!tracks || tracks.length === 0) {
        return undefined;
      }
      return new MediaStream(tracks);
    };
    this.mediaStream = ko.observable();
    this.audioMediaStream = ko.pureComputed(() => createMediaStreamOfType('getAudioTracks'));
    this.videoMediaStream = ko.pureComputed(() => createMediaStreamOfType('getVideoTracks'));

    this.isVisible = false;

    const selfUser = this.userRepository.self;
    this.isTemporaryGuest = ko.pureComputed(() => selfUser() && selfUser().isTemporaryGuest());

    this.audioContext = undefined;
    this.audioInterval = undefined;
    this.audioLevel = ko.observable(0);
    this.audioSource = undefined;

    this.brandName = this.Config.BRAND_NAME;

    this.supportsAudioOutput = ko.pureComputed(() => {
      return this.deviceSupport.audioOutput() && Environment.browser.supports.audioOutputSelection;
    });
  }

  /**
   * Initiate media devices.
   * @returns {undefined} No return value
   */
  async initiateDevices(): Promise<void> {
    this.isVisible = true;

    try {
      const mediaStream = await this._getMediaStream();
      if (typeof mediaStream === 'boolean') {
        return;
      }
      this.mediaStream(mediaStream);
      if (mediaStream && !this.audioInterval) {
        this._initiateAudioMeter(mediaStream);
      }
    } catch (error) {
      this.logger.warn(`Requesting MediaStream failed: ${error.message}`, error);
    }
  }

  tryAgain() {
    this.releaseDevices();
    this.initiateDevices();
  }

  /**
   * Release media devices.
   * @returns {undefined} No return value.
   */
  releaseDevices(): void {
    this.isVisible = false;
    this._releaseAudioMeter();
    this._releaseMediaStream();
  }

  /**
   * Get current MediaStream or initiate it.
   * @private
   * @param {MediaType} requestedMediaType MediaType to request the user
   * @returns {Promise} Resolves with a MediaStream
   */
  async _getMediaStream(requestedMediaType = MediaType.AUDIO_VIDEO): Promise<MediaStream | boolean> {
    if (!this.deviceSupport.videoInput() && !this.deviceSupport.audioInput()) {
      return Promise.resolve(undefined);
    }
    const supportsVideo = this.deviceSupport.videoInput();
    const supportsAudio = this.deviceSupport.audioInput();
    const requestAudio = supportsAudio && [MediaType.AUDIO, MediaType.AUDIO_VIDEO].includes(requestedMediaType);
    const requestVideo = supportsVideo && [MediaType.VIDEO, MediaType.AUDIO_VIDEO].includes(requestedMediaType);
    try {
      const stream = this.streamHandler.requestMediaStream(requestAudio, requestVideo, false, false);
      this.devicesHandler.refreshMediaDevices();
      return stream;
    } catch (error) {
      // if getting the streams all together failed, we try to get them separately.
      return this.getStreamsSeparately(requestAudio, requestVideo, error);
    }
  }

  async getStreamsSeparately(
    requestAudio: boolean,
    requestVideo: boolean,
    error: Error,
  ): Promise<boolean | MediaStream> {
    try {
      const splitMediaStreamsAttempts = [];
      if (requestAudio) {
        splitMediaStreamsAttempts.push(
          this.streamHandler.requestMediaStream(true, false, false, false).catch(() => undefined),
        );
      }
      if (requestVideo) {
        splitMediaStreamsAttempts.push(
          this.streamHandler.requestMediaStream(false, true, false, false).catch(() => undefined),
        );
      }
      return Promise.all(splitMediaStreamsAttempts).then(mediaStreams => {
        const workingMediaStreams = mediaStreams.filter(mediaStream => !!mediaStream);
        if (workingMediaStreams.length === 0) {
          throw error;
        }
        const tracks = workingMediaStreams.reduce((trackList, mediaStream) => {
          return trackList.concat(mediaStream.getTracks());
        });
        return new MediaStream(tracks);
      });
    } catch (error) {
      this.logger.warn(`Requesting MediaStream failed: ${error.message}`, error);
      const expectedErrors = [MediaError.TYPE.MEDIA_STREAM_DEVICE, MediaError.TYPE.MEDIA_STREAM_PERMISSION];

      const isExpectedError = expectedErrors.includes(error.type);
      if (isExpectedError) {
        return false;
      }

      throw error;
    }
  }

  /**
   * Initiate audio meter.
   *
   * @private
   * @param {MediaStream} mediaStream MediaStream to measure audio levels on
   * @returns {undefined} No return value
   */
  _initiateAudioMeter(mediaStream: MediaStream) {
    this.logger.info('Initiating new audio meter', mediaStream);
    if (!window.AudioContext || !window.AudioContext.prototype.createMediaStreamSource) {
      this.logger.warn('AudioContext is not supported, no volume indicator can be generated');
    }
    this.audioContext = new window.AudioContext();

    const audioAnalyser = this.audioContext.createAnalyser();
    audioAnalyser.fftSize = PreferencesAVViewModel.CONFIG.AUDIO_METER.FFT_SIZE;
    audioAnalyser.smoothingTimeConstant = PreferencesAVViewModel.CONFIG.AUDIO_METER.SMOOTHING_TIME_CONSTANT;

    const audioDataArray = new Float32Array(audioAnalyser.frequencyBinCount);

    this.audioInterval = window.setInterval(() => {
      audioAnalyser.getFloatFrequencyData(audioDataArray);
      let volume = 0;

      // Data is in the db range of -100 to -30, but can also be -Infinity. We normalize the value up to -50 to the range of 0, 1.
      for (const dataPoint of audioDataArray) {
        volume += Math.abs(Math.max(dataPoint, -100) + 100) / 50;
      }

      const averageVolume = volume / audioDataArray.length;

      this.audioLevel(averageVolume - PreferencesAVViewModel.CONFIG.AUDIO_METER.LEVEL_ADJUSTMENT);
    }, PreferencesAVViewModel.CONFIG.AUDIO_METER.INTERVAL);

    this.audioSource = this.audioContext.createMediaStreamSource(mediaStream);
    this.audioSource.connect(audioAnalyser);
  }

  async _releaseAudioMeter(): Promise<void> {
    window.clearInterval(this.audioInterval);
    this.audioInterval = undefined;

    if (this.audioContext) {
      try {
        await this.audioContext.close();
        this.logger.info('Closed existing AudioContext', this.audioContext);
        this.audioContext = undefined;
      } catch (error) {
        this.logger.error(error);
      }
    }

    if (this.audioSource) {
      this.audioSource.disconnect();
      this.audioSource = undefined;
    }
  }

  _releaseMediaStream() {
    if (this.mediaStream()) {
      this.streamHandler.releaseTracksFromStream(this.mediaStream(), this.currentMediaType);
      this.mediaStream(undefined);
    }
  }
}