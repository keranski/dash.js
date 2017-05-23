/**
 * The copyright in this software is being made available under the BSD License,
 * included below. This software may be subject to other third party and contributor
 * rights, including patent rights, and no such rights are granted under this license.
 *
 * Copyright (c) 2013, Dash Industry Forum.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without modification,
 * are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice, this
 *  list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *  this list of conditions and the following disclaimer in the documentation and/or
 *  other materials provided with the distribution.
 *  * Neither the name of Dash Industry Forum nor the names of its
 *  contributors may be used to endorse or promote products derived from this software
 *  without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS AS IS AND ANY
 *  EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 *  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 *  IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT,
 *  INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 *  NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 *  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
 *  WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */
import DashManifestModel from '../models/DashManifestModel';
import DashMetrics from '../DashMetrics';
import TimelineConverter from '../utils/TimelineConverter';
import AbrController from '../../streaming/controllers/AbrController';
import PlaybackController from '../../streaming/controllers/PlaybackController';
import ManifestModel from '../../streaming/models/ManifestModel';
import Error from '../../streaming/vo/Error';
import EventBus from '../../core/EventBus';
import Events from '../../core/events/Events';
import MediaPlayerEvents from '../../streaming/MediaPlayerEvents';
import FactoryMaker from '../../core/FactoryMaker';
import Representation from '../vo/Representation';

function RepresentationController(config) {

    const SEGMENTS_UPDATE_FAILED_ERROR_CODE = 1;

    let context = this.context;
    let eventBus = EventBus(context).getInstance();
    let streamProcessor = config.streamProcessor;

    let instance,
        realAdaptation,
        realAdaptationIndex,
        updating,
        voAvailableRepresentations,
        currentVoRepresentation,
        abrController,
        indexHandler,
        playbackController,
        metricsModel,
        domStorage,
        timelineConverter,
        dashManifestModel,
        dashMetrics,
        manifestModel;

    function setup() {
        realAdaptation = null;
        realAdaptationIndex = -1;
        updating = true;
        voAvailableRepresentations = [];

        abrController = AbrController(context).getInstance();
        playbackController = PlaybackController(context).getInstance();
        timelineConverter = TimelineConverter(context).getInstance();
        dashManifestModel = DashManifestModel(context).getInstance();
        dashMetrics = DashMetrics(context).getInstance();
        manifestModel = ManifestModel(context).getInstance();

        eventBus.on(Events.QUALITY_CHANGE_REQUESTED, onQualityChanged, instance);
        eventBus.on(Events.REPRESENTATION_UPDATED, onRepresentationUpdated, instance);
        eventBus.on(Events.WALLCLOCK_TIME_UPDATED, onWallclockTimeUpdated, instance);
        eventBus.on(Events.BUFFER_LEVEL_UPDATED, onBufferLevelUpdated, instance);
    }

    function setConfig(config) {
        // allow the abrController created in setup to be overidden
        if (config.abrController) {
            abrController = config.abrController;
        }
        if (config.domStorage) {
            domStorage = config.domStorage;
        }
        if (config.metricsModel) {
            metricsModel = config.metricsModel;
        }
    }

    function initialize() {
        indexHandler = streamProcessor.getIndexHandler();
    }

    function getStreamProcessor() {
        return streamProcessor;
    }

    function getData() {
        return realAdaptation;
    }

    function getDataIndex() {
        return realAdaptationIndex;
    }

    function isUpdating() {
        return updating;
    }

    function getCurrentRepresentation() {
        return currentVoRepresentation;
    }

    function reset() {

        eventBus.off(Events.QUALITY_CHANGE_REQUESTED, onQualityChanged, instance);
        eventBus.off(Events.REPRESENTATION_UPDATED, onRepresentationUpdated, instance);
        eventBus.off(Events.WALLCLOCK_TIME_UPDATED, onWallclockTimeUpdated, instance);
        eventBus.off(Events.BUFFER_LEVEL_UPDATED, onBufferLevelUpdated, instance);


        realAdaptation = null;
        realAdaptationIndex = -1;
        updating = true;
        voAvailableRepresentations = [];
        abrController = null;
        playbackController = null;
        metricsModel = null;
        domStorage = null;
        timelineConverter = null;
        dashManifestModel = null;
        dashMetrics = null;
    }

    function updateData(newRealAdaptation, voAdaptation, type) {
        let quality,
            averageThroughput;

        let bitrate = null;
        let streamInfo = streamProcessor.getStreamInfo();
        let maxQuality = abrController.getTopQualityIndexFor(type, streamInfo.id);

        updating = true;
        eventBus.trigger(Events.DATA_UPDATE_STARTED, {sender: this});

        voAvailableRepresentations = updateRepresentations(voAdaptation);

        if (realAdaptation === null && type !== 'fragmentedText') {
            averageThroughput = abrController.getThroughputHistory().getAverageThroughput(type);
            bitrate = averageThroughput || abrController.getInitialBitrateFor(type, streamInfo);
            quality = abrController.getQualityForBitrate(streamProcessor.getMediaInfo(), bitrate);
        } else {
            quality = abrController.getQualityFor(type, streamInfo);
        }

        if (quality > maxQuality) {
            quality = maxQuality;
        }

        currentVoRepresentation = getRepresentationForQuality(quality);
        realAdaptation = newRealAdaptation;

        if (type !== 'video' && type !== 'audio' && type !== 'fragmentedText') {
            updating = false;
            eventBus.trigger(Events.DATA_UPDATE_COMPLETED, {sender: this, data: realAdaptation, currentRepresentation: currentVoRepresentation});
            return;
        }

        for (let i = 0; i < voAvailableRepresentations.length; i++) {
            indexHandler.updateRepresentation(voAvailableRepresentations[i], true);
        }
    }

    function addRepresentationSwitch() {
        let now = new Date();
        let currentRepresentation = getCurrentRepresentation();
        let currentVideoTimeMs = playbackController.getTime() * 1000;

        metricsModel.addRepresentationSwitch(currentRepresentation.adaptation.type, now, currentVideoTimeMs, currentRepresentation.id);
    }

    function addDVRMetric() {
        let range = timelineConverter.calcSegmentAvailabilityRange(currentVoRepresentation, streamProcessor.isDynamic());
        metricsModel.addDVRInfo(streamProcessor.getType(), playbackController.getTime(), streamProcessor.getStreamInfo().manifestInfo, range);
    }

    function getRepresentationForQuality(quality) {
        return voAvailableRepresentations[quality];
    }

    function getQualityForRepresentation(voRepresentation) {
        return voAvailableRepresentations.indexOf(voRepresentation);
    }

    function isAllRepresentationsUpdated() {
        for (let i = 0, ln = voAvailableRepresentations.length; i < ln; i++) {
            let segmentInfoType = voAvailableRepresentations[i].segmentInfoType;
            if (voAvailableRepresentations[i].segmentAvailabilityRange === null || !Representation.hasInitialization(voAvailableRepresentations[i]) ||
                    ((segmentInfoType === 'SegmentBase' || segmentInfoType === 'BaseURL') && !voAvailableRepresentations[i].segments)
            ) {
                return false;
            }
        }

        return true;
    }

    function updateRepresentations(voAdaptation) {
        let voReps;

        realAdaptationIndex = dashManifestModel.getIndexForAdaptation(realAdaptation, voAdaptation.period.mpd.manifest, voAdaptation.period.index);
        voReps = dashManifestModel.getRepresentationsForAdaptation(voAdaptation);

        return voReps;
    }

    function updateAvailabilityWindow(isDynamic) {
        let voRepresentation;

        for (let i = 0, ln = voAvailableRepresentations.length; i < ln; i++) {
            voRepresentation = voAvailableRepresentations[i];
            voRepresentation.segmentAvailabilityRange = timelineConverter.calcSegmentAvailabilityRange(voRepresentation, isDynamic);
        }
    }

    function resetAvailabilityWindow() {
        voAvailableRepresentations.forEach(rep => {
            rep.segmentAvailabilityRange = null;
        });
    }

    function postponeUpdate(postponeTimePeriod) {
        let delay = postponeTimePeriod;
        let update = function () {
            if (isUpdating()) return;

            updating = true;
            eventBus.trigger(Events.DATA_UPDATE_STARTED, { sender: instance });

            // clear the segmentAvailabilityRange for all reps.
            // this ensures all are updated before the live edge search starts
            resetAvailabilityWindow();

            for (let i = 0; i < voAvailableRepresentations.length; i++) {
                indexHandler.updateRepresentation(voAvailableRepresentations[i], true);
            }
        };

        updating = false;
        eventBus.trigger(MediaPlayerEvents.AST_IN_FUTURE, { delay: delay });
        setTimeout(update, delay);
    }

    function onRepresentationUpdated(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor || !isUpdating()) return;

        let r = e.representation;
        let streamMetrics = metricsModel.getMetricsFor('stream');
        let metrics = metricsModel.getMetricsFor(getCurrentRepresentation().adaptation.type);
        let manifestUpdateInfo = dashMetrics.getCurrentManifestUpdate(streamMetrics);
        let alreadyAdded = false;
        let postponeTimePeriod = 0;
        let repInfo,
            err,
            repSwitch;

        if (r.adaptation.period.mpd.manifest.type === 'dynamic')
        {
            let segmentAvailabilityTimePeriod = r.segmentAvailabilityRange.end - r.segmentAvailabilityRange.start;
            // We must put things to sleep unless till e.g. the startTime calculation in ScheduleController.onLiveEdgeSearchCompleted fall after the segmentAvailabilityRange.start
            let liveDelay = playbackController.computeLiveDelay(currentVoRepresentation.segmentDuration, streamProcessor.getStreamInfo().manifestInfo.DVRWindowSize);
            postponeTimePeriod = (liveDelay - segmentAvailabilityTimePeriod) * 1000;
        }

        if (postponeTimePeriod > 0) {
            addDVRMetric();
            postponeUpdate(postponeTimePeriod);
            err = new Error(SEGMENTS_UPDATE_FAILED_ERROR_CODE, 'Segments update failed', null);
            eventBus.trigger(Events.DATA_UPDATE_COMPLETED, {sender: this, data: realAdaptation, currentRepresentation: currentVoRepresentation, error: err});

            return;
        }

        if (manifestUpdateInfo) {
            for (let i = 0; i < manifestUpdateInfo.trackInfo.length; i++) {
                repInfo = manifestUpdateInfo.trackInfo[i];
                if (repInfo.index === r.index && repInfo.mediaType === streamProcessor.getType()) {
                    alreadyAdded = true;
                    break;
                }
            }

            if (!alreadyAdded) {
                metricsModel.addManifestUpdateRepresentationInfo(manifestUpdateInfo, r.id, r.index, r.adaptation.period.index,
                        streamProcessor.getType(),r.presentationTimeOffset, r.startNumber, r.segmentInfoType);
            }
        }

        if (isAllRepresentationsUpdated()) {
            updating = false;
            abrController.setPlaybackQuality(streamProcessor.getType(), streamProcessor.getStreamInfo(), getQualityForRepresentation(currentVoRepresentation));
            metricsModel.updateManifestUpdateInfo(manifestUpdateInfo, {latency: currentVoRepresentation.segmentAvailabilityRange.end - playbackController.getTime()});

            repSwitch = dashMetrics.getCurrentRepresentationSwitch(metrics);

            if (!repSwitch) {
                addRepresentationSwitch();
            }

            eventBus.trigger(Events.DATA_UPDATE_COMPLETED, {sender: this, data: realAdaptation, currentRepresentation: currentVoRepresentation});
        }
    }

    function onWallclockTimeUpdated(e) {
        if (e.isDynamic) {
            updateAvailabilityWindow(e.isDynamic);
        }
    }

    function onBufferLevelUpdated(e) {
        if (e.sender.getStreamProcessor() !== streamProcessor) return;
        let manifest = manifestModel.getValue();
        if (!manifest.doNotUpdateDVRWindowOnBufferUpdated) {
            addDVRMetric();
        }
    }

    function onQualityChanged(e) {
        if (e.mediaType !== streamProcessor.getType() || streamProcessor.getStreamInfo().id !== e.streamInfo.id) return;

        if (e.oldQuality !== e.newQuality) {
            currentVoRepresentation = getRepresentationForQuality(e.newQuality);
            domStorage.setSavedBitrateSettings(e.mediaType, currentVoRepresentation.bandwidth);
            addRepresentationSwitch();
        }
    }

    instance = {
        initialize: initialize,
        setConfig: setConfig,
        getData: getData,
        getDataIndex: getDataIndex,
        isUpdating: isUpdating,
        updateData: updateData,
        getStreamProcessor: getStreamProcessor,
        getCurrentRepresentation: getCurrentRepresentation,
        getRepresentationForQuality: getRepresentationForQuality,
        reset: reset
    };

    setup();
    return instance;
}

RepresentationController.__dashjs_factory_name = 'RepresentationController';
export default FactoryMaker.getClassFactory(RepresentationController);
