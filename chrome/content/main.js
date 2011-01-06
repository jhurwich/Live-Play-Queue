
// Make a namespace.
if (typeof LivePlayQueue == 'undefined') {
  var LivePlayQueue = {};
}

// useful shortcuts
if (typeof(Cc) == "undefined")
  var Cc = Components.classes;
if (typeof(Ci) == "undefined")
  var Ci = Components.interfaces;
if (typeof(Cr) == "undefined")
  var Cr = Components.results;
if (typeof(Cu) == "undefined")
  var Cu = Components.utils;

Cu.import("resource://app/jsmodules/PlayQueueUtils.jsm");
Cu.import("resource://app/jsmodules/sbProperties.jsm");

/* first let's get the sbIPlaylistCommandsHelper which will help us add our
 * action button */
var cmdHelper = Cc["@songbirdnest.com/Songbird/PlaylistCommandsHelper;1"]
                  .getService(Ci.sbIPlaylistCommandsHelper);

// We need access to the queueService so we can get the play queue's GUID.
var pqService = Cc["@songbirdnest.com/Songbird/playqueue/service;1"]
                  .getService(Ci.sbIPlayQueueService);

var mediacoreMgr = Cc["@songbirdnest.com/Songbird/Mediacore/Manager;1"]
                  .getService(Ci.sbIMediacoreManager);

var sequencer = mediacoreMgr.sequencer;

/**
 * UI controller that is loaded into the main player window
 */
LivePlayQueue.Controller = {

  pqGUID: pqService.mediaList.guid,
  cmd: null,
  desiredPos: 0,

  // sbIDataRemotes used to signal to shuffle buttons
  /* We overlay our own copy of the shuffle button into the button hbox
   * then use liveActivatedRemote to signal if ours ( when true ) or the
   * original shuffle button ( when false ) should be used.
   * shuffledRemote is our signal with our own button to know whether it
   * is activated (shuffled) or not.
   */
  liveActivatedRemote: null,
  shuffledRemote: null,

  /**
   * Called when the window finishes loading
   */
  onLoad: function() {

    // initialize the data remotes that we'll need
    /* This remote, when true, hides the normal shuffle and shows ours.
     * As well, it is the chief indicator for if the live playqueue is
     * activated, that is if this addon should intercept all play events
     * and redirect them to the queue. */
    this.liveActivatedRemote = Cc["@songbirdnest.com/Songbird/DataRemote;1"]
                                .createInstance(Ci.sbIDataRemote);
    this.liveActivatedRemote.init("livequeue.stealshuffle", null);

    var valCheck = this.liveActivatedRemote.stringValue;
    if (valCheck == "")
      this.liveActivatedRemote.boolValue = false;

    // this remote indicates whether _our_ shuffle is activated
    this.shuffledRemote = Cc["@songbirdnest.com/Songbird/DataRemote;1"]
                            .createInstance(Ci.sbIDataRemote);
    this.shuffledRemote.init("livequeue.shuffled", null);

    valCheck = this.shuffledRemote.stringValue;
    if (valCheck == "")
      this.shuffledRemote.boolValue = false;

    var flags = {
      NONE: 0,
      QUEUE_SOME: 1,
    };
    var listenerFlag = flags.NONE;

    // this mediacore listener intercepts track change events that
    // are changing to a library that is not the play queue's and
    // reloads that view into the play queue and plays it
    var mediacoreListener = {
      onMediacoreEvent : function(ev) {

        // we only care about 'before track change' events
        // and only when the live play queue is active
        if (ev.type == Ci.sbIMediacoreEvent.BEFORE_TRACK_CHANGE &&
            LivePlayQueue.Controller.liveActivatedRemote.boolValue )
        {
          // the mediaItem being switched to is the data
          var newMediaItem = ev.data;

          // check if we are trying to play an item outside of the play queue
          if (newMediaItem.library != pqService.mediaList.library)
          {
            // first, prevent the track outside the play queue from playing
            sequencer.abort();

            //clear the playqueue to prepare it for the new queue
            pqService.clearAll();

            // this flag lets the play queue listener know the queue is from us
            listenerFlag = flags.QUEUE_SOME;

            // copy the items around the newMediaItem to the playqueue
            LivePlayQueue.Controller.copySequenceToPlayQueue(newMediaItem);

            /* We are done here because copySequenceToPlayQueue will
             * call pqService.queueSome() and we will need to wait for
             * that operation to complete before we can trigger playback
             * from the play queue.
             * The play queue listener defined below is what causes play
             * */
          }
        }

        return;
      },
    };

    /* This listener is necessary to detect when new mediaitem and
     * the tracks around it are finished being queued.  When they are
     * queued, we can start playing from the one the user clicked */

    var pqListener = {
      onIndexUpdated : function(aToIndex) {},
      onQueueOperationStarted : function() {},

      onQueueOperationCompleted : function() {
        // the listenerFlag helps us know that the operation is ours
        switch (listenerFlag)
        {
        case flags.QUEUE_SOME:
          // desiredPos is set by copySequenceToPlayQueue
          PlayQueueUtils.play(LivePlayQueue.Controller.desiredPos);
          break;
        default:
          break;
        }
        listenerFlag = flags.NONE;
        LivePlayQueue.Controller.desiredPos = 0;
      },
    };
    // now add the listeners that we created
    pqService.addListener(pqListener);
    mediacoreMgr.addListener(mediacoreListener);

    // the play queue's commands are split at the top level into toolbar and other
    var pqToolbarCmd = cmdHelper.getCommandObjectForGUID
                                    (cmdHelper.TARGET_TOOLBAR,
                                     this.pqGUID,
                                     "playqueue-toolbar-cmds");

    // within the toolbar commands, we need to find the dropdown submenu
    var toolbarCmds = pqToolbarCmd.getChildrenCommandObjects();
    var playQueueSubMenu = null;
    while (toolbarCmds.hasMoreElements())
    {
      var cmd = toolbarCmds.getNext().QueryInterface(Ci.sbIPlaylistCommandsBuilder);
      if (cmd.id == "clearhistory-playqueue-cmd")
        playQueueSubMenu = cmd
    }

    // add our flag that indicates if live play queue is activated to the submenu
    playQueueSubMenu.appendFlag("playqueue_cmd_clearhistory",
                                "live-playqueue-flag",
                                "Live Play Queue",
                                "Activate or Deactivate Play Queue",
                                LivePlayQueue.Controller.flagCallback,
                                function () {
                                  return LivePlayQueue.Controller.isPlayQueueLive();
                                });
    // notify listeners so that the playlist toolbar will refresh itself
    playQueueSubMenu.notifyListeners("onCommandAdded", playQueueSubMenu);
  },

  /* callback for when the playlist command flag is clicked, causes the
   * live play queue to activate or deactive */
  flagCallback: function(context, submenu, commandid, host) {
    LivePlayQueue.Controller.togglePlayQueueLive();
  },

  /* This function copies MaxItems (as defined by a pref) number of
   * items around the sequencer's viewPosition to the playqueue.
   *
   * First, we'll try to copy MaxItems/2 from both before and after
   * theat position. However, if that makes us fall off an edge we'll
   * add more items from the opposite side. */
  copySequenceToPlayQueue: function(mediaItemToPlay) {
    // the view currently being played
    var view = sequencer.view;

    // begin with the indexes so that an equal number will be added from
    // before and after the item being played
    var startIndex = sequencer.viewPosition - this.getMaxItems()/2;
    var endIndex = sequencer.viewPosition + this.getMaxItems()/2;

    // if we fall off the end with endIndex, add the extra to before
    if (endIndex > view.length)
    {
      startIndex -= endIndex - view.length;
    }

    // if we fall off the end with startIndex, add the extra to the end
    if (startIndex < 0)
    {
      endIndex += (startIndex * -1);
    }

    // fix the indexes if they are illegal
    if (endIndex > view.length)
      endIndex = view.length;

    if (startIndex < 0)
      startIndex = 0;

    // Now prepare the items that will be added to the playqueue by adding
    // them to this array in the order they should show up in the play queue.
    var mediaItems = new Array();
    if (!this.shuffledRemote.boolValue) { // live play queue is  not shuffled

      // if we aren't shuffled, this is easy just grab them
      for (var i = startIndex; i < endIndex; i++)
      {
        var currItem = view.getItemByIndex(i);
        mediaItems.push(currItem);
      }

      // desiredPos tells the playqueue listener where to begin playing
      // from after our queue operation finishes.
      LivePlayQueue.Controller.desiredPos = sequencer.viewPosition - startIndex;
    }
    else { // live play queue is shuffled

      // get a list of all the indexes of the items (outside of the playqueue)
      // we will be adding to the plarqueue
      var nums = new Array();
      for (var i = startIndex; i < endIndex; i++)
      {
        nums.push(i);
      }

      // randomly select from those numbers, and add the item at that
      // index to our array.  The currently playing item goes first.
      while(nums.length > 0)
      {
        // randomly pick an index
        var rand = Math.floor(Math.random() * nums.length);
        var mIIndex = nums[rand];

        // remove that index so we can't get it again (no dups)
        nums.splice(rand, 1);

        // get the item at the randomly picked index
        var currItem = view.getItemByIndex(mIIndex);
        if (mediaItemToPlay == currItem)
        {
          // if the current item is the one that we will be playing,
          // put that item first.
          mediaItems.unshift(currItem);
        }
        else {
          mediaItems.push(currItem);
        }
      }

      /* for a shuffled playqueue we put the playing item first, so
       * set desiredPos to 0 so that the playqueue listener will begin
       * playing that item at the top */
      LivePlayQueue.Controller.desiredPos = 0;
    }

    // now we do the queueing
    pqService.queueSomeNext(ArrayConverter.enumerator(mediaItems));
  },

  // called when _our_ shuffle button is clicked, toggling the shuffled state
  onShuffle: function() {
    this.shuffledRemote.boolValue = !this.shuffledRemote.boolValue;
  },

  /**
   * Called when the window is about to close
   */
  onUnLoad: function() {
  },

  // utilty to get the max number of items to queue at once from our pref
  getMaxItems: function() {
    return Application.prefs.get("extensions.live-play-queue.maxitems").value;
  },

  isPlayQueueLive: function() {
    return LivePlayQueue.Controller.liveActivatedRemote.boolValue;
  },

  togglePlayQueueLive: function() {
    LivePlayQueue.Controller.liveActivatedRemote.boolValue =
      !LivePlayQueue.Controller.liveActivatedRemote.boolValue;
  }

};

window.addEventListener("load", function(e) { LivePlayQueue.Controller.onLoad(e); }, false);
window.addEventListener("unload", function(e) { LivePlayQueue.Controller.onUnLoad(e); }, false);
