/**
 * Constructor for an analogue of the TimeRanges class
 * returned by various HTMLMediaElement properties
 *
 * Pass an array of two-element arrays, each containing a start and end time.
 */
OgvJsTimeRanges = window.OgvJsTimeRanges = function(ranges) {
	Object.defineProperty(this, 'length', {
		get: function getLength() {
			return ranges.length;
		}
	});
	this.start = function(i) {
		return ranges[i][0];
	};
	this.end = function(i) {
		return ranges[i][1];
	}
	return this;
}

/**
 * Player class -- instantiate one of these to get an 'ogvjs' HTML element
 * which has a similar interface to the HTML audio/video elements.
 *
 * @param options: optional dictionary of options:
 *                 'base': string; base URL for additional resources, such as Flash audio shim
 *                 'webGL': bool; pass true to use WebGL acceleration if available
 *                 'forceWebGL': bool; pass true to require WebGL even if not detected
 */
OgvJsPlayer = window.OgvJsPlayer = function(options) {
	options = options || {};
	var webGLdetected = WebGLFrameSink.isAvailable();
	var useWebGL = !!options.webGL && webGLdetected;
	if(!!options.forceWebGL) {
		useWebGL = true;
		if(!webGLdetected) {
			console.log("No support for WebGL detected, but WebGL forced on!");
		}
	}
	
	var State = {
		INITIAL: 'INITIAL',
		SEEKING_END: 'SEEKING_END',
		LOADED: 'LOADED',
		PLAYING: 'PLAYING',
		PAUSED: 'PAUSED',
		SEEKING: 'SEEKING',
		ENDED: 'ENDED'
	}, state = State.INITIAL;
	
	var SeekState = {
		NOT_SEEKING: 'NOT_SEEKING',
		BISECT_TO_TARGET: 'BISECT_TO_TARGET',
		BISECT_TO_KEYPOINT: 'BISECT_TO_KEYPOINT',
		LINEAR_TO_TARGET: 'LINEAR_TO_TARGET'
	}, seekState = SeekState.NOT_SEEKING;
	
	var audioOptions = {};
	if (typeof options.base === 'string') {
		// Pass the resource dir down to AudioFeeder,
		// so it can load the dynamicaudio.swf
		audioOptions.base = options.base;
	}
	if (typeof options.audioContext !== 'undefined') {
		// Try passing a pre-created audioContext in?
		audioOptions.audioContext = options.audioContext;
	}
	
	var canvas = document.createElement('canvas');
	var frameSink;
	
	// Return a magical custom element!
	var self = document.createElement('ogvjs');
	self.style.display = 'inline-block';
	self.style.position = 'relative';
	self.style.width = '0px'; // size will be expanded later
	self.style.height = '0px';

	canvas.style.position = 'absolute';
	canvas.style.top = '0';
	canvas.style.left = '0';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	self.appendChild(canvas);

	var getTimestamp;
	if (window.performance === undefined || window.performance.now === undefined) {
		getTimestamp = Date.now;
	} else {
		getTimestamp = window.performance.now.bind(window.performance);
	}

	var placeboCodec, codec, audioFeeder;
	var muted = false,
		initialAudioPosition = 0.0,
		initialAudioOffset = 0.0;
	function initAudioFeeder() {
		console.log('init audio feeder');
		audioFeeder = new AudioFeeder( audioOptions );
		if (muted) {
			audioFeeder.mute();
		}
		audioFeeder.onstarved = function() {
			// If we're in a background tab, timers may be throttled.
			// When audio buffers run out, go decode some more stuff.
			pingProcessing();
		};
		audioFeeder.init(audioInfo.channels, audioInfo.rate);
	}
	
	function startAudio(offset) {
		audioFeeder.start();
		var state = audioFeeder.getPlaybackState();
		initialAudioPosition = state.playbackPosition;
		if (offset !== undefined) {
			initialAudioOffset = offset;
		}
		console.log('START AUDIO AT', initialAudioPosition, initialAudioOffset);
	}
	
	function stopAudio() {
		initialAudioOffset = getAudioTime();
		audioFeeder.stop();
	}
	
	/**
	 * Get audio playback time position in file's units
	 *
	 * @return {number} seconds since file start
	 */
	function getAudioTime(state) {
		state = state || audioFeeder.getPlaybackState();
		//console.log(state.playbackPosition, initialAudioPosition, initialAudioOffset);
		return (state.playbackPosition - initialAudioPosition) + initialAudioOffset;
	}

	var stream,
		byteLength = 0,
		duration = null,
		lastSeenTimestamp = null,
		nextProcessingTimer,
		started = false,
		paused = true,
		ended = false,
		loadedMetadata = false,
		startedPlaybackInDocument = false;
	
	var framesPlayed = 0;
	// Benchmark data, exposed via getPlaybackStats()
	var framesProcessed = 0, // frames
		targetPerFrameTime = 1000 / 60, // ms
		demuxingTime = 0, // ms
		videoDecodingTime = 0, // ms
		audioDecodingTime = 0, // ms
		bufferTime = 0, // ms
		drawingTime = 0, // ms
		totalJitter = 0; // sum of ms we're off from expected frame delivery time
	// Benchmark data that doesn't clear
	var droppedAudio = 0; // number of times we were starved for audio

	function stopVideo() {
		// kill the previous video if any
		paused = true; // ?
		ended = true;
		
		continueVideo = null;
		
		if (stream) {
			stream.abort();
			stream = null;
		}
		if (placeboCodec) {
			placeboCodec.destroy();
			placeboCodec = null;
		}
		if (codec) {
			codec.destroy();
			codec = null;
		}
		if (audioFeeder) {
			audioFeeder.close();
			audioFeeder = null;
		}
		if (nextProcessingTimer) {
			clearTimeout(nextProcessingTimer);
			nextProcessingTimer = null;
		}
	}
	
	function togglePauseVideo() {
		if (self.paused) {
			self.play();
		} else {
			self.pause();
		}
	}
	
	var continueVideo = null;
	
	var lastFrameTime = getTimestamp(),
		frameEndTimestamp = 0.0,
		yCbCrBuffer = null;
	var lastFrameDecodeTime = 0.0;		
	var targetFrameTime;
	var lastFrameTimestamp = 0.0;

	function processFrame() {
		yCbCrBuffer = codec.dequeueFrame();
		frameEndTimestamp = yCbCrBuffer.timestamp;
	}

	function drawFrame() {
		if (thumbnail) {
			self.removeChild(thumbnail);
			thumbnail = null;
		}

		var start, delta;

		start = getTimestamp();

		frameSink.drawFrame(yCbCrBuffer);

		delta = getTimestamp() - start;
		lastFrameDecodeTime += delta;
		drawingTime += delta;

		framesProcessed++;
		framesPlayed++;

		doFrameComplete();
	}

	function doFrameComplete() {
		if (startedPlaybackInDocument && !document.body.contains(self)) {
			// We've been de-parented since we last ran
			// Stop playback at next opportunity!
			setTimeout(function() {
				self.stop();
			}, 0);
		}

		var newFrameTimestamp = getTimestamp(),
			wallClockTime = newFrameTimestamp - lastFrameTimestamp,
			jitter = Math.abs(wallClockTime - 1000 / fps);
		totalJitter += jitter;

		if (self.onframecallback) {
			self.onframecallback({
				cpuTime: lastFrameDecodeTime,
				clockTime: wallClockTime
			});
		}
		lastFrameDecodeTime = 0;
		lastFrameTimestamp = newFrameTimestamp;
	}


	// -- seek functions
	var seekTargetTime = 0.0,
		seekTargetKeypoint = 0.0,
		bisectTargetTime = 0.0,
		lastSeekPosition,
		lastFrameSkipped,
		seekBisector;

	function startBisection(targetTime) {
		bisectTargetTime = targetTime;
		seekBisector = new Bisector({
			start: 0,
			end: stream.bytesTotal - 1,
			process: function(start, end, position) {
				if (position == lastSeekPosition) {
					return false;
				} else {
					lastSeekPosition = position;
					lastFrameSkipped = false;
					codec.flush();
					stream.seek(position);
					stream.readBytes();
					return true;
				}
			}
		});
		seekBisector.start();
	}

	function seek(toTime) {
		if (stream.bytesTotal == 0) {
			throw new Error('Cannot bisect a non-seekable stream');
		}
		state = State.SEEKING;
		seekTargetTime = toTime;
		seekTargetKeypoint = -1;
		lastFrameSkipped = false;
		lastSeekPosition = -1;
		codec.flush();
		
		if (codec.hasAudio && audioFeeder) {
			stopAudio();
		}
		
		var offset = codec.getKeypointOffset(toTime);
		if (offset > 0) {
			// This file has an index!
			//
			// Start at the keypoint, then decode forward to the desired time.
			//
			seekState = SeekState.LINEAR_TO_TARGET;
			stream.seek(offset);
			stream.readBytes();
		} else {
			// No index.
			//
			// Bisect through the file finding our target time, then we'll
			// have to do it again to reach the keypoint, and *then* we'll
			// have to decode forward back to the desired time.
			//
			seekState = SeekState.BISECT_TO_TARGET;
			startBisection(seekTargetTime);
		}
	}
	
	function continueSeekedPlayback() {
		seekState = SeekState.NOT_SEEKING;
		state = State.PLAYING;
		frameEndTimestamp = codec.frameTimestamp;
		console.log('SEEKED', codec.audioTimestamp, codec.frameTimestamp);
		if (codec.hasAudio) {
			seekTargetTime = codec.audioTimestamp;
			startAudio(seekTargetTime);
		} else {
			seekTargetTime = codec.frameTimestamp;
		}
	}
	
	/**
	 * @return {boolean} true to continue processing, false to wait for input data
	 */
	function doProcessLinearSeeking() {
		var frameDuration;
		if (codec.hasVideo) {
			frameDuration = 1 / videoInfo.fps;
		} else {
			frameDuration = 1 / 256; // approximate packet audio size, fake!
		}
		
		if (codec.hasVideo) {
			if (!codec.frameReady) {
				// Haven't found a frame yet, process more data
				return true;
			} else if (codec.frameTimestamp < 0 || codec.frameTimestamp + frameDuration < seekTargetTime) {
				// Haven't found a time yet, or haven't reached the target time.
				// Decode it in case we're at our keyframe or a following intraframe...
				codec.decodeFrame();
				codec.dequeueFrame();
				return true;
			} else {
				// Reached or surpassed the target time. 
				if (codec.hasAudio) {
					// Keep processing the audio track
				} else {
					continueSeekedPlayback();
					return false;
				}
			}
		}
		if (codec.hasAudio) {
			if (!codec.audioReady) {
				// Haven't found an audio packet yet, process more data
				return true;
			}
			if (codec.audioTimestamp < 0 || codec.audioTimestamp + frameDuration < seekTargetTime) {
				// Haven't found a time yet, or haven't reached the target time.
				// Decode it so when we reach the target we've got consistent data.
				codec.decodeAudio();
				codec.dequeueAudio();
				return true;
			} else {
				continueSeekedPlayback();
				return false;
			}
		}
		return true;
	}
	
	function doProcessBisectionSeek() {
		var frameDuration,
			timestamp;
		if (codec.hasVideo) {
			if (!codec.frameReady) {
				console.log('no frame found yet');
				// Haven't found a frame yet, process more data
				return true;
			}
			timestamp = codec.frameTimestamp;
			frameDuration = 1 / videoInfo.fps;
		} else if (codec.hasAudio) {
			if (!codec.audioReady) {
				console.log('no audio found yet');
				// Haven't found an audio packet yet, process more data
				return true;
			}
			timestamp = codec.audioTimestamp;
			frameDuration = 1 / 256; // approximate packet audio size, fake!
		} else {
			throw new Error('Invalid seek state; no audio or video track available');
		}

		if (timestamp < 0) {
			console.log('no timestamps found yet');
			// Haven't found a time yet.
			// Decode in case we're at our keyframe or a following intraframe...
			if (codec.frameReady) {
				codec.decodeFrame();
				codec.dequeueFrame();
			}
			if (codec.audioReady) {
				codec.decodeAudio();
				codec.dequeueAudio();
			}
			return true;
		} else if (timestamp - frameDuration > bisectTargetTime) {
			console.log('frame too high', codec.frameTimestamp, bisectTargetTime);
			if (seekBisector.left()) {
				// wait for new data to come in
			} else {
				console.log('gave up on bisect left');
				seekTargetTime = codec.frameTimestamp;
				continueSeekedPlayback();
			}
			return false;
		} else if (timestamp + frameDuration < bisectTargetTime) {
			console.log('frame too low', codec.frameTimestamp, bisectTargetTime);
			if (seekBisector.right()) {
				// wait for new data to come in
			} else {
				console.log('gave up on bisect right');
				seekTargetTime = codec.frameTimestamp;
				continueSeekedPlayback();
			}
			return false;
		} else {
			console.log('found it?', timestamp, bisectTargetTime);
			// Reached the bisection target!
			if (seekState == SeekState.BISECT_TO_TARGET && (codec.hasVideo && codec.keyframeTimestamp < codec.frameTimestamp)) {
				// We have to go back and find a keyframe. Sigh.
				seekState = SeekState.BISECT_TO_KEYPOINT;
				startBisection(codec.keyframeTimestamp);
				return false;
			} else {
				// Switch to linear mode to find the final target.
				seekState = SeekState.LINEAR_TO_TARGET;
				return true;
			}
		}
		return true;
	}
	

	/**
	 * In IE, pushing data to the Flash shim is expensive.
	 * Combine multiple small Vorbis packet outputs into
	 * larger buffers so we don't have to make as many calls.
	 */
	function joinAudioBuffers(buffers) {
		if (buffers.length == 1) {
			return buffers[0];
		}
		var sampleCount = 0,
			channelCount = buffers[0].length,
			i,
			c,
			out = [];
		for (i = 0; i < buffers.length; i++) {
			sampleCount += buffers[i][0].length;
		}
		for (c = 0; c < channelCount; c++) {
			var channelOut = new Float32Array(sampleCount);
			var position = 0;
			for (i = 0; i < buffers.length; i++) {
				var channelIn = buffers[i][c];
				channelOut.set(channelIn, position);
				position += channelIn.length;
			}
			out.push(channelOut);
		}
		return out;
	}

	function doProcessing() {
		nextProcessingTimer = null;
		
		var audioBuffers = [];
		function queueAudio() {
			if (audioBuffers.length > 0) {
				var start = getTimestamp();
				audioFeeder.bufferData(joinAudioBuffers(audioBuffers));
				var delta = (getTimestamp() - start);
				lastFrameDecodeTime += delta;
				bufferTime += delta;

				if (!codec.hasVideo) {
					framesProcessed++; // pretend!
					doFrameComplete();
				}
			}
		}
		
		var audioBufferedDuration = 0,
			decodedSamples = 0,
			audioState = null;

		var n = 0;
		while (true) {
			//console.log(n, state, codec.hasAudio, codec.audioReady, codec.audioTimestamp, codec.hasVideo, codec.frameReady, codec.frameTimestamp);
			n++;
			if (n > 100) {
				//throw new Error("Got stuck in the loop!");
				console.log("Got stuck in the loop!");
				pingProcessing(10);
				return;
			}

			if (state == State.INITIAL) {
				if (placeboCodec) {
					placeboCodec.process();
				}
				var more = codec.process();

				if (loadedMetadata) {
					// we just fell over from headers into content; call onloadedmetadata etc
					if (!codec.hasVideo && !codec.hasAudio) {
						throw new Error('No audio or video found, something is wrong');
						return;
					}
					if (duration === null) {
						if (stream.seekable) {
							console.log('Seeking to find duration...');
							state = State.SEEKING_END;
							lastSeenTimestamp = -1;
							codec.flush();
							stream.seek(Math.max(0, stream.bytesTotal - 65536 * 2));
							stream.readBytes();
							return;
						} else {
							console.log('Stream not seekable and no x-content-duration; assuming infinite stream.');
							state = State.LOADED;
							continue;
						}
					} else {
						// We already know the duration.
						state = State.LOADED;
						continue;
					}
				}

				if (!more) {
					// Read more data!
					stream.readBytes();
					return;
				} else {
					// Keep processing headers
					continue;
				}
			}
			
			if (state == State.SEEKING_END) {
				// Look for the last item.
				var more = codec.process();
				
				//console.log('video', codec.hasVideo, codec.frameReady, codec.frameTimestamp);
				if (codec.hasVideo && codec.frameReady) {
					lastSeenTimestamp = Math.max(lastSeenTimestamp, codec.frameTimestamp);
					codec.discardFrame();
				}
				//console.log('audio', codec.hasAudio, codec.audioReady, codec.audioTimestamp);
				if (codec.hasAudio && codec.audioReady) {
					lastSeenTimestamp = Math.max(lastSeenTimestamp, codec.audioTimestamp);
					codec.decodeAudio();
					codec.dequeueAudio();
				}
				//console.log('lastSeenTimestamp', lastSeenTimestamp);
				
				if (!more) {
					// Read more data!
					if (stream.bytesRead < stream.bytesTotal) {
						stream.readBytes();
						return;
					} else {
						// We are at the end!
						if (lastSeenTimestamp > 0) {
							duration = lastSeenTimestamp;
							console.log('detected duration ' + duration + ' from end');
						} else {
							console.log('did not find a duration');
						}
						
						// Ok, seek back to the beginning and resync the streams.
						state = State.LOADED;
						codec.flush();
						stream.seek(0);
						stream.readBytes();
						return;
					}
				} else {
					// Keep processing headers
					continue;
				}
			}
			
			if (state == State.LOADED) {
				state = State.READY;
				if (self.onloadedmetadata) {
					self.onloadedmetadata();
				}
				if (paused) {
					// Paused? stop here.
					return;
				} else {
					// Not paused? Continue on to play processing.
					continue;
				}
			}
			
			if (state == State.READY) {
				console.log('metadata!', codec, codec.hasAudio, codec.hasVideo, duration);
				state = State.PLAYING;
				lastFrameTimestamp = getTimestamp();
				targetFrameTime = lastFrameTimestamp + 1000.0 / fps
				if (codec.hasAudio) {
					initAudioFeeder();
					audioFeeder.waitUntilReady(function() {
						startAudio(0.0);
						pingProcessing(0);
					});
				} else {
					pingProcessing(0);
				}

				// Fall over to play processing
				return;
			}
			
			if (state == State.SEEKING) {
				if (!codec.process()) {
					stream.readBytes();
					return;
				}
				if (seekState == SeekState.NOT_SEEKING) {
					throw new Error('seeking in invalid state (not seeking?)');
				} else if (seekState == SeekState.BISECT_TO_TARGET) {
					doProcessBisectionSeek();
				} else if (seekState == SeekState.BISECT_TO_KEYPOINT) {
					doProcessBisectionSeek();
				} else if (seekState == SeekState.LINEAR_TO_TARGET) {
					doProcessLinearSeeking();
				}
				
				// Back to the loop to process more data
				continue;
			}
			
			// Process until we run out of data or
			// completely decode a video frame...
			var currentTime = getTimestamp();
			var start = getTimestamp();
	
			var more = codec.process();
			
			var delta = (getTimestamp() - start);
			lastFrameDecodeTime += delta;
			demuxingTime += delta;

			if (!more) {
				queueAudio();
				if (stream) {
					// Ran out of buffered input
					stream.readBytes();
				} else {
					// Ran out of stream!
					var finalDelay = 0;
					if (codec.hasAudio) {
						// This doesn't seem to be enough with Flash audio shim.
						// Not quite sure why.
						finalDelay = audioBufferedDuration;
					}
					console.log('End of stream reached in ' + finalDelay + ' ms.');
					setTimeout(function() {
						stopVideo();
						ended = true;
						if (self.onended) {
							self.onended();
						}
					}, finalDelay);
				}
				return;
			}
			
			if ((codec.hasAudio || codec.hasVideo) && !(codec.audioReady || codec.frameReady)) {
				// Have to process some more pages to find data. Continue the loop.
				continue;
			}

			if (codec.hasAudio && audioFeeder) {
				if (!audioState) {
					audioState = audioFeeder.getPlaybackState();
					audioPlaybackPosition = getAudioTime(audioState);
					audioBufferedDuration = (audioState.samplesQueued / audioFeeder.targetRate) * 1000;
					droppedAudio = audioState.dropped;
				}

				// Drive on the audio clock!
				var fudgeDelta = 0.1,
					readyForAudio = audioState.samplesQueued <= (audioFeeder.bufferSize * 2),
					frameDelay = (frameEndTimestamp - audioPlaybackPosition) * 1000,
					readyForFrame = (frameDelay <= fudgeDelta);
				//console.log('frame', readyForFrame, codec.frameReady, frameEndTimestamp, audioPlaybackPosition, frameDelay);
				//console.log('audio', readyForAudio, codec.audioReady, audioPlaybackPosition, audioBufferedDuration);

				var startTimeSpent = getTimestamp();
				if (codec.audioReady && readyForAudio) {
					//console.log('audio', readyForAudio, codec.audioReady, audioPlaybackPosition, audioBufferedDuration);
					var start = getTimestamp();
					var ok = codec.decodeAudio();
					var delta = (getTimestamp() - start);
					lastFrameDecodeTime += delta;
					audioDecodingTime += delta;

					var start = getTimestamp();
					if (ok) {
						var buffer = codec.dequeueAudio();
						//audioFeeder.bufferData(buffer);
						audioBuffers.push(buffer);
						audioBufferedDuration += (buffer[0].length / audioInfo.rate) * 1000;
						decodedSamples += buffer[0].length;
					}
				}
				if (codec.frameReady && readyForFrame) {
					var start = getTimestamp();
					var ok = codec.decodeFrame();
					var delta = (getTimestamp() - start);
					lastFrameDecodeTime += delta;
					videoDecodingTime += delta;
					if (ok) {
						processFrame();
						drawFrame();
					} else {
						// Bad packet or something.
						console.log('Bad video packet or something');
					}
					targetFrameTime = currentTime + 1000.0 / fps;
				}
			
				// Check in when all audio runs out
				var bufferDuration = (audioFeeder.bufferSize / audioFeeder.targetRate) * 1000;
				var nextDelays = [];
				if (audioBufferedDuration <= bufferDuration * 2) {
					// NEED MOAR BUFFERS
				} else {
					// Check in when the audio buffer runs low again...
					nextDelays.push(bufferDuration / 2);
					
					if (codec.hasVideo) {
						// Check in when the next frame is due
						// Subtract time we already spent decoding
						var deltaTimeSpent = getTimestamp() - startTimeSpent;
						nextDelays.push(frameDelay - deltaTimeSpent);
					}
				}
				
				//console.log(n, audioPlaybackPosition, frameEndTimestamp, audioBufferedDuration, bufferDuration, frameDelay, '[' + nextDelays.join("/") + ']');
				var nextDelay = Math.min.apply(Math, nextDelays);
				if (nextDelays.length > 0) {
					if (placeboCodec) {
						// We've primed the JIT compiler... or something... by now;
						// throw away the placebo copy.
						placeboCodec.destroy();
						placeboCodec = null;
					}

					// Keep track of how much time we spend queueing audio as well
					// This is slow when using the Flash shim on IE 10/11
					var start = getTimestamp();
					queueAudio();
					var delta = getTimestamp() - start;
					pingProcessing(Math.max(0, nextDelay - delta));
					return;
				}
			} else if (codec.hasVideo) {
				// Video-only: drive on the video clock
				if (codec.frameReady && getTimestamp() >= targetFrameTime) {
					if (placeboCodec) {
						// We've primed the JIT compiler... or something... by now;
						// throw away the placebo copy.
						placeboCodec.destroy();
						placeboCodec = null;
					}

					// it's time to draw
					var start = getTimestamp();
					var ok = codec.decodeFrame();
					var delta = (getTimestamp() - start);
					lastFrameDecodeTime += delta;
					videoDecodingTime += delta;
					if (ok) {
						processFrame();
						drawFrame();
						targetFrameTime += 1000.0 / fps;
						pingProcessing(0);
					} else {
						console.log('Bad video packet or something');
						pingProcessing(Math.max(0, targetFrameTime - getTimestamp()));
					}
				} else {
					// check in again soon!
					pingProcessing(Math.max(0, targetFrameTime - getTimestamp()));
				}
				return;
			} else {
				// Ok we're just waiting for more input.
				console.log('Still waiting for headers...');
			}
		}
	}

	function pingProcessing(delay) {
		if (delay === undefined) {
			delay = -1;
		}
		if (delay >= 0) {
			if (nextProcessingTimer) {
				// already scheduled
				return;
			}
			//console.log('delaying for ' + delay);
			nextProcessingTimer = setTimeout(doProcessing, delay);
		} else {
			if (nextProcessingTimer) {
				clearTimeout(nextProcessingTimer);
			}
			doProcessing(); // warning: tail recursion is possible
		}
	}

	var fps = 60;

	var videoInfo,
		audioInfo;

	function startProcessingVideo() {
		var options = {};
		
		// Mozilla/5.0 (Macintosh; Intel Mac OS X 10_8_5) AppleWebKit/536.30.1 (KHTML, like Gecko) Version/6.0.5 Safari/536.30.1
		if (navigator.userAgent.match(/Version\/6\.0\.[0-9a-z.]+ Safari/)) {
			// Something may be wrong with the JIT compiler in Safari 6.0;
			// when we decode Vorbis with the debug console closed it falls
			// into 100% CPU loop and never exits.
			//
			// Blacklist audio decoding for this browser.
			//
			// Known working in Safari 6.1 and 7.
			options.audio = false;
			console.log('Audio disabled due to bug on Safari 6.0');
		}
		
		framesProcessed = 0;
		demuxingTime = 0;
		videoDecodingTime = 0;
		audioDecodingTime = 0;
		bufferTime = 0;
		drawingTime = 0;
		started = true;

		// There's some kind of problem with the JIT in iOS 7 Safari
		// that sometimes trips up on optimized Vorbis builds, at least
		// on my iPad 3 (A5X SoC).
		//
		// Exercising some of the ogg & vorbis library code paths with
		// a second decoder for the first few packets of data seems to
		// be enough to work around this.
		//
		// Non-deterministic debugging ROCKS!
		//
		placeboCodec = new OgvJs(options);

		codec = new OgvJs(options);
		codec.oninitvideo = function(info) {
			videoInfo = info;
			fps = info.fps;
			targetPerFrameTime = 1000 / fps;
			
			if (width == 0) {
				self.style.width = self.videoWidth + 'px';
			}
			if (height == 0) {
				self.style.height = self.videoHeight + 'px';
			}
			
			canvas.width = info.picWidth;
			canvas.height = info.picHeight;
			console.log('useWebGL is', useWebGL);
			if (useWebGL) {
				frameSink = new WebGLFrameSink(canvas, videoInfo);
			} else {
				frameSink = new FrameSink(canvas, videoInfo);
			}
		};
		codec.oninitaudio = function(info) {
			audioInfo = info;
		};
		codec.onloadedmetadata = function() {
			loadedMetadata = true;
			console.log('skeleton duration', codec.duration);
			if (!isNaN(codec.duration)) {
				// Use duration from ogg skeleton index
				duration = codec.duration;
			}
		};

		stream.readBytes();
	}
	
	function loadCodec(callback) {
		if (typeof window.OgvJs == 'function') {
			if (callback) {
				callback();
			}
		} else if (OgvJsPlayer.loadingNode !== null) {
			if (callback) {
				OgvJsPlayer.loadingCallbacks.push(callback);
			}
		} else {
			if (callback) {
				OgvJsPlayer.loadingCallbacks.push(callback);
			}
			OgvJsPlayer.loadingNode = document.createElement('script');
			document.querySelector('head').appendChild(OgvJsPlayer.loadingNode);

			var url = 'ogv-codec.js';
			if (options.base) {
				url = options.base + '/' + url;
			}
			if (typeof window.OgvJsVersion === 'string') {
				url = url + '?version=' + encodeURIComponent(window.OgvJsVersion);
			}
			
			OgvJsPlayer.loadingNode.onload = function() {
				if (typeof window.OgvJs === 'function') {
					OgvJsPlayer.loadingCallbacks.forEach(function(cb) {
						cb();
					});
					OgvJsPlayer.loadingNode.onload = null;
					OgvJsPlayer.loadingCallbacks.splice(0, OgvJsPlayer.loadingCallbacks.length);
				} else {
					throw new Error('Could not load ogv-codec.js');
				}
			};
			OgvJsPlayer.loadingNode.src = url;
		}
	}
	
	/**
	 * HTMLMediaElement load method
	 */
	self.load = function() {
		if (stream) {
			// already loaded.
			return;
		}
	
		loadCodec();

		started = false;
		stream = new StreamFile({
			url: self.src,
			bufferSize: 65536 * 4,
			onstart: function() {
				// Fire off the read/decode/draw loop...
				byteLength = stream.bytesTotal;
				console.log('byteLength: ' + byteLength);
			
				// If we get X-Content-Duration, that's as good as an explicit hint
				var durationHeader = stream.getResponseHeader('X-Content-Duration');
				if (typeof durationHeader === 'string') {
					duration = parseFloat(durationHeader);
					console.log('X-Content-Duration: ' + duration);
				}
				loadCodec(startProcessingVideo);
			},
			onread: function(data) {
				// Pass chunk into the codec's buffer
				codec.receiveInput(data);
				if (placeboCodec) {
					placeboCodec.receiveInput(data);
				}

				// Continue the read/decode/draw loop...
				pingProcessing();
			},
			ondone: function() {
				if (state == State.SEEKING) {
					console.log("bumped into end during seeking?");
					pingProcessing();
				} else if (state == State.SEEKING_END) {
					console.log("bumped into end during seeking-to-end, that's probably good");
					pingProcessing();
				} else {
					console.log("reading^H^H^^H^H buffering? done.");
					//throw new Error('wtf is this');
					stream = null;
			
					// Let the read/decode/draw loop know we're out!
					pingProcessing();
				}
			},
			onerror: function(err) {
				console.log("reading error: " + err);
			}
		});
	};
	
	/**
	 * HTMLMediaElement canPlayType method
	 */
	self.canPlayType = function(type) {
		// @todo: implement better parsing
		if (type === 'audio/ogg; codecs="vorbis"') {
			return 'probably';
		} else if (type === 'audio/ogg; codecs="opus"') {
			return 'probably';
		} else if (type.match(/^audio\/ogg\b/)) {
			return 'maybe';
		} else if (type === 'video/ogg; codecs="theora"') {
			return 'probably';
		} else if (type === 'video/ogg; codecs="theora,vorbis"') {
			return 'probably';
		} else if (type === 'video/ogg; codecs="theora,opus"') {
			return 'probably';
		} else if (type.match(/^video\/ogg\b/)) {
			return 'maybe';
		} else {
			return '';
		}
	};
	
	/**
	 * HTMLMediaElement play method
	 */
	self.play = function() {
		if (!audioOptions.audioContext) {
			OgvJsPlayer.initSharedAudioContext();
		}
		
		if (!stream) {
			self.load();
		}
		
		if (paused) {
			startedPlaybackInDocument = document.body.contains(self);
			paused = false;
			if (continueVideo) {
				continueVideo();
			} else {
				continueVideo = function() {
					if (audioFeeder) {
						startAudio();
					}
					pingProcessing(0);
				}
				if (!started) {
					loadCodec(startProcessingVideo);
				} else {
					continueVideo();
				}
			}
			if (self.onplay) {
				self.onplay();
			}
		}
	};
	
	/**
	 * custom getPlaybackStats method
	 */
	self.getPlaybackStats = function() {
		return {
			targetPerFrameTime: targetPerFrameTime,
			framesProcessed: framesProcessed,
			demuxingTime: demuxingTime,
			videoDecodingTime: videoDecodingTime,
			audioDecodingTime: audioDecodingTime,
			bufferTime: bufferTime,
			drawingTime: drawingTime,
			droppedAudio: droppedAudio,
			jitter: totalJitter / framesProcessed
		};
	};
	self.resetPlaybackStats = function() {
		framesProcessed = 0;
		demuxingTime = 0;
		videoDecodingTime = 0;
		audioDecodingTime = 0;
		bufferTime = 0;
		drawingTime = 0;
		totalJitter = 0;
	};
	
	/**
	 * HTMLMediaElement pause method
	 */
	self.pause = function() {
		if (!stream) {
			console.log('initializing stream');
			paused = true;
			self.load();
		} else if (!paused) {
			console.log('pausing');
			clearTimeout(nextProcessingTimer);
			nextProcessingTimer = null;
			if (audioFeeder) {
				stopAudio();
			}
			paused = true;
			if (self.onpause) {
				self.onpause();
			}
		}
	};
	
	/**
	 * custom 'stop' method
	 */
	self.stop = function() {
		stopVideo();
	};

	/**
	 * HTMLMediaElement src property
	 */
	self.src = "";
	
	/**
	 * HTMLMediaElement buffered property
	 */
	Object.defineProperty(self, "buffered", {
		get: function getBuffered() {
			var estimatedBufferTime;
			if (stream && byteLength && duration) {
				estimatedBufferTime = (stream.bytesBuffered / byteLength) * duration;
			} else {
				estimatedBufferTime = 0;
			}
			return new OgvJsTimeRanges([[0, estimatedBufferTime]]);
		}
	});
	
	/**
	 * HTMLMediaElement seekable property
	 */
	Object.defineProperty(self, "seekable", {
		get: function getSeekable() {
			if (duration === null) {
				return new OgvJsTimeRanges([]);
			} else {
				return new OgvJsTimeRanges([[0, duration]]);
			}
		}
	});
	
	/**
	 * HTMLMediaElement currentTime property
	 */
	Object.defineProperty(self, "currentTime", {
		get: function getCurrentTime() {
			if (state == State.SEEKING) {
				return seekTargetTime;
			} else {
				if (codec && codec.hasAudio && audioFeeder) {
					if (paused) {
						return initialAudioOffset - initialAudioPosition;
					} else {
						return getAudioTime();
					}
				} else if (codec && codec.hasVideo) {
					return frameEndTimestamp;
				} else {
					return 0;
				}
			}
		},
		set: function setCurrentTime(val) {
			if (stream && byteLength && duration) {
				seek(val);
			}
		}
	});
	
	/**
	 * HTMLMediaElement duration property
	 */
	Object.defineProperty(self, "duration", {
		get: function getDuration() {
			if (codec && loadedMetadata) {
				if (duration !== null) {
					return duration;
				} else {
					return Infinity;
				}
			} else {
				return NaN;
			}
		}
	});
	
	/**
	 * HTMLMediaElement paused property
	 */
	Object.defineProperty(self, "paused", {
		get: function getPaused() {
			return paused;
		}
	});
	
	/**
	 * HTMLMediaElement ended property
	 */
	Object.defineProperty(self, "ended", {
		get: function getEnded() {
			return ended;
		}
	});
	
	/**
	 * HTMLMediaElement ended property
	 */
	Object.defineProperty(self, "seeking", {
		get: function getEnded() {
			return (state == State.SEEKING);
		}
	});
	
	/**
	 * HTMLMediaElement muted property
	 */
	Object.defineProperty(self, "muted", {
		get: function getMuted() {
			return muted;
		},
		set: function setMuted(val) {
			muted = val;
			if (audioFeeder) {
				if (muted) {
					audioFeeder.mute();
				} else {
					audioFeeder.unmute();
				}
			}
		}
	});
	
	var poster = '', thumbnail;
	Object.defineProperty(self, "poster", {
		get: function getPoster() {
			return poster;
		},
		set: function setPoster(val) {
			poster = val;
			if (!started) {
				if (thumbnail) {
					self.removeChild(thumbnail);
				}
				thumbnail = new Image();
				thumbnail.src = poster;
				thumbnail.className = 'ogvjs-poster';
				thumbnail.style.position = 'absolute';
				thumbnail.style.top = '0';
				thumbnail.style.left = '0';
				thumbnail.style.width = '100%';
				thumbnail.style.height = '100%';
				thumbnail.onload = function() {
					if (width == 0) {
						self.style.width = thumbnail.naturalWidth + 'px';
					}
					if (height == 0) {
						self.style.height = thumbnail.naturalHeight + 'px';
					}
				}
				self.appendChild(thumbnail);
			}
		}
	});
	
	// Video metadata properties...
	Object.defineProperty(self, "videoWidth", {
		get: function getVideoWidth() {
			if (videoInfo) {
				if (videoInfo.aspectNumerator > 0 && videoInfo.aspectDenominator > 0) {
					return Math.round(videoInfo.picWidth * videoInfo.aspectNumerator / videoInfo.aspectDenominator);
				} else {
					return videoInfo.picWidth;
				}
			} else {
				return 0;
			}
		}
	});
	Object.defineProperty(self, "videoHeight", {
		get: function getVideoHeight() {
			if (videoInfo) {
				return videoInfo.picHeight;
			} else {
				return 0;
			}
		}
	});
	Object.defineProperty(self, "ogvjsVideoFrameRate", {
		get: function getOgvJsVideoFrameRate() {
			if (videoInfo) {
				return videoInfo.fps;
			} else {
				return 0;
			}
		}
	});
	
	// Audio metadata properties...
	Object.defineProperty(self, "ogvjsAudioChannels", {
		get: function getOgvJsAudioChannels() {
			if (audioInfo) {
				return audioInfo.channels;
			} else {
				return 0;
			}
		}
	});
	Object.defineProperty(self, "ogvjsAudioSampleRate", {
		get: function getOgvJsAudioChannels() {
			if (audioInfo) {
				return audioInfo.rate;
			} else {
				return 0;
			}
		}
	});
	
	// Display size...
	var width = 0, height = 0;
	Object.defineProperty(self, "width", {
		get: function getWidth() {
			return width;
		},
		set: function setWidth(val) {
			width = parseInt(val, 10);
			self.style.width = width + 'px';
		}
	});
	
	Object.defineProperty(self, "height", {
		get: function getHeight() {
			return height;
		},
		set: function setHeight(val) {
			height = parseInt(val, 10);
			self.style.height = height + 'px';
		}
	});

	// Events!

	/**
	 * custom onframecallback, takes frame decode time in ms
	 */
	self.onframecallback = null;
	
	/**
	 * Called when all metadata is available.
	 * Note in theory we must know 'duration' at this point.
	 */
	self.onloadedmetadata = null;
	
	/**
	 * Called when we start playback
	 */
	self.onplay = null;
	
	/**
	 * Called when we get paused
	 */
	self.onpause = null;
	
	/**
	 * Called when playback ends
	 */
	self.onended = null;
	
	return self;
}

OgvJsPlayer.initSharedAudioContext = function() {
	AudioFeeder.initSharedAudioContext();
};

OgvJsPlayer.loadingNode = null,
OgvJsPlayer.loadingCallbacks = [];
