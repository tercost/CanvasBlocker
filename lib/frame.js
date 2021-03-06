/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
(function(require){
	"use strict";
	
	const settings = require("./settings");
	const {preIntercept: intercept} = require("./intercept.js");
	const {ask} = require("./askForPermission.js");
	const lists = require("./lists.js");
	const {check: originalCheck, checkStack: originalCheckStack} = require("./check.js");
	const getWrapped = require("sdk/getWrapped");
	const extension = require("./extension");
	
	const logging = require("./logging");
	const {error, warning, message, notice, verbose, setPrefix: setLogPrefix} = logging;
	setLogPrefix("frame script");
	
	// Variable to "unload" the script
	var enabled = true;
	
	message("starting", location.href);
	
	function check(message){
		if (enabled){
			return originalCheck(message);
		}
		else {
			return {type: [], mode: "allow"};
		}
	}
	function checkStack(stack){
		if (enabled){
			return originalCheckStack(stack);
		}
		else {
			return true;
		}
	}
	function askWrapper(data){
		return ask(data, {
			_: extension.getTranslation,
			prefs
		});
	}
	
	message("open port to background script");
	var port = browser.runtime.connect();
	if (window === window.top){
		message("Is top level window -> tab had navigation -> clear page action");
		port.postMessage({"canvasBlocker-clear-page-action": true});
	}
	var tabId;
	port.onMessage.addListener(function(data){
		message("Got data from port", data);
		if (data.hasOwnProperty("tabId")){
			notice("my tab id is", data.tabId);
			tabId = data.tabId;
		}
		const persistentRndName = "persistent" + (extension.inIncognitoContext? "Incognito": "") + "Rnd";
		if (data.hasOwnProperty(persistentRndName)){
			const persistentRndValue = data[persistentRndName];
			notice("got persistent random data", persistentRndValue);
			const {persistent: persistentRnd} = require("./randomSupplies.js");
			Object.keys(persistentRndValue).forEach(function(domain){
				verbose("random data for", domain, persistentRndValue[domain]);
				persistentRnd.setDomainRnd(domain, persistentRndValue[domain]);
			});
		}
	});
	var notifications = [];
	var notificationCounter = {};
	var sentAPIs = {};
	function notify(data){
		if (!settings.ignoredAPIs[data.api]){
			if (settings.storeNotificationData){
				notifications.push(data);
			}
			notificationCounter[data.messageId] = (notificationCounter[data.messageId] || 0) + 1;
			if (!sentAPIs[data.api]){
				sentAPIs[data.api] = true;
				port.postMessage({"canvasBlocker-notify": data});
			}
		}
	}
	
	function prefs(...args){
		return settings.get(...args);
	}
	
	
	var interceptedWindows = new WeakMap();
	function interceptWindow(window){
		try {
			var href = window.location.href;
		}
		catch (e){
			// we are unable to read the location due to SOP
			// therefore we also can not intercept anything.
			warning("NOT intercepting window due to SOP", window);
			return false;
		}
		
		if (!enabled || interceptedWindows.get(getWrapped(window))){
			return false;
		}
		
		message("intercepting window", window);
		intercept(
			{subject: window},
			{check, checkStack, ask: askWrapper, notify, prefs}
		);
		message("prepare to intercept (i)frames.");

		[window.HTMLIFrameElement, window.HTMLFrameElement].forEach(function(constructor){
			var oldContentWindowGetter = constructor.prototype.__lookupGetter__("contentWindow");
			Object.defineProperty(
				getWrapped(constructor.prototype),
				"contentWindow",
				{
					enumerable: true,
					configurable: true,
					get: exportFunction(function(){
						var window = oldContentWindowGetter.call(this);
						if (window){
							interceptWindow(window);
						}
						return window;
					}, window)
				}
			);
			var oldContentDocumentGetter = constructor.prototype.__lookupGetter__("contentDocument");
			Object.defineProperty(
				getWrapped(constructor.prototype),
				"contentDocument",
				{
					enumerable: true,
					configurable: true,
					get: exportFunction(function(){
						var document = oldContentDocumentGetter.call(this);
						if (document){
							interceptWindow(document.defaultView);
						}
						return document;
					}, window)
				}
			);
		});
		
		interceptedWindows.set(getWrapped(window), true);
		return true;
	}
	
	message("register listener for messages from background script");
	extension.message.on(function(data){
		if (data["canvasBlocker-unload"]){
			enabled = false;
		}
		if (
			data.hasOwnProperty("canvasBlocker-sendNotifications") &&
			data["canvasBlocker-sendNotifications"] === tabId
		){
			notice("sending notifications:", notifications);
			extension.message.send({
				sender: tabId,
				url: window.location.href,
				"canvasBlocker-notificationCounter": notificationCounter,
				"canvasBlocker-notifications": notifications
			});
			notice("notifications sent");
		}
	});
	
	interceptWindow(window);
}(require));