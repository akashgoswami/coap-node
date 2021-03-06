'use strict';

var _ = require('busyman');

var cutils = require('./cutils'),
    CNST = require('./constants');

/**** Code Enumerations ****/
var TTYPE = CNST.TTYPE,
    TAG = CNST.TAG,
    ERR = CNST.ERR,
    RSP = CNST.RSP;

var helper = {};

/*********************************************************
 * helper                                                *
 *********************************************************/
helper.lfUpdate = function (cn, enable) {
    clearInterval(cn._updater);
    cn._updater = null;

    if (enable) {
        cn._updater = setInterval(function () {
            _.forEach(cn.serversInfo, function (serverInfo, ssid) {
                if (serverInfo.registered) {
                    serverInfo.lfsecs += 1;
                    if (serverInfo._lfsecs >= (cn.lifetime - 10)) {
                        cn.update({}, function (err, msg) {
                            if (err) {
                                cn.emit('error', err);
                            } else {
                                // if (msg.status === RSP.notfound)
                                //     helper.lfUpdate(cn, false); 
                            }
                        });

                        serverInfo._lfsecs = 0;
                    }
                }
            });
        }, 1000);
    }
};

helper.heartbeat = function (cn, ssid, enable, rsp) {
    var serverInfo = cn.serversInfo[ssid];
    
    clearInterval(serverInfo.hbPacemaker);
    serverInfo.hbPacemaker = null;
    
    if (serverInfo.hbStream.stream) {
        serverInfo.hbStream.stream.removeListener('finish', serverInfo.hbStream.finishCb);
        serverInfo.hbStream.stream.end();
        serverInfo.hbStream.stream = null;
        cn.emit('logout');
    }

    if (enable) {
        serverInfo.hbStream.stream = rsp;
        serverInfo.hbStream.finishCb = function () {
            clearInterval(serverInfo.hbPacemaker);
            cn.emit('offline');
            if (cn.autoReRegister === true) 
                helper.reRegister(cn, ssid);
        };

        rsp.on('finish', serverInfo.hbStream.finishCb);

        serverInfo.hbPacemaker = setInterval(function () {
            try {
                serverInfo.hbStream.stream.write('hb');
            } catch (e) {
                cn.emit('error', e);
            }
        }, cn._config.heartbeatTime * 1000);
        cn.emit('login');
    }
};

helper.reRegister = function (cn, ssid) {
    var serverInfo = cn.serversInfo[ssid];
    
    cn.emit('reconnect');
    cn._register(serverInfo.ip, serverInfo.port, function (err, msg) {
        if (!msg || !(msg.status === RSP.created)) {
            setTimeout(function () {
                helper.reRegister(cn);
            }, 5000);
        }
    });
};

helper.checkAndBuildObjList = function (cn, check, opts) {
    var objList = cn.getSmartObject().objectList(),
        objListInPlain = '',
        newObjList = {};


    _.forEach(objList, function (rec) {
        newObjList[rec.oid] = rec.iid;
    });

    if (!_.isEmpty(cn.objList) && _.isEqual(cn.objList, newObjList) && check === true)
        return null;       // not diff

    cn.objList = newObjList;

    if (opts) {
        objListInPlain += '</>';

        _.forEach(opts, function (val, key) {
            if (key === 'ct' && val === 'application/json') 
                objListInPlain += ';ct=11543';
            else if (key === 'hb' && val === true)
                objListInPlain += ';hb';
        });

        objListInPlain += ',';
    }

    _.forEach(newObjList, function (iidArray, oidNum) {
        var oidNumber = oidNum;

        if (oidNum === 0 || oidNum === '0')
            return;

        if (_.isEmpty(iidArray)) {
            objListInPlain += '</' + oidNumber + '>';
            if (opts.obs) objListInPlain += ';obs'
            objListInPlain += ',';
        } else {
            _.forEach(iidArray, function (iid) {
                objListInPlain += '</' + oidNumber + '/' + iid + '>';
                if (opts.obs) objListInPlain += ';obs'
                objListInPlain += ',';
            });
        }
    });

    if (objListInPlain[objListInPlain.length-1] === ',')           
        objListInPlain = objListInPlain.slice(0, objListInPlain.length - 1);

    return objListInPlain;
};


helper.checkAndReportResrc = function (cn, oid, iid, rid, val) {
    _.forEach(cn.serversInfo, function (serverInfo, ssid) {
        helper._checkAndReportResrc(cn, ssid, oid, iid, rid, val);
    });
};

helper._checkAndReportResrc = function (cn, ssid, oid, iid, rid, val) {
    var serverInfo = cn.serversInfo[ssid],
        target = cn._target(oid, iid, rid),
        oidKey = target.oidKey,
        ridKey = target.ridKey,
        rAttrs = cn._getAttrs(ssid, oid, iid, rid),
        iAttrs = cn._getAttrs(ssid, oid, iid),
        rpt = serverInfo.reporters[target.pathKey],
        iRpt = serverInfo.reporters[oidKey + '/' + iid],
        iObj = {},
        chkRp;

    if (!rAttrs.enable && !iAttrs.enable)
        return false;

    if (_.isNil(rAttrs.lastRpVal))
        rAttrs.lastRpVal = iAttrs.lastRpVal[ridKey];

    chkRp = chackResourceAttrs(val, rAttrs.gt, rAttrs.lt, rAttrs.stp, rAttrs.lastRpVal);

    // chack Resource pmin and report
    if (rAttrs.mute && rAttrs.enable) {
        setTimeout(function () {
            helper._checkAndReportResrc(cn, ssid, oid, iid, rid, val);
        }, rAttrs.pmin * 1000);
    } else if (!rAttrs.mute && chkRp && rAttrs.enable && _.isFunction(rpt.write)) {
        rpt.write(val);
    }

    // chack Object Instance pmin and report
    if (iAttrs.mute && iAttrs.enable) {
        setTimeout(function () {
            helper._checkAndReportResrc(cn, ssid, oid, iid, rid, val);
        }, iAttrs.pmin * 1000);
    } else if (!iAttrs.mute && chkRp && iAttrs.enable && _.isFunction(iRpt.write)) {
        iObj[ridKey] = val;
        iRpt.write(iObj);
    }
};

helper.checkAndCloseServer = function (cn, enable) {
    clearInterval(cn._socketServerChker);
    cn._socketServerChker = null;

    if (enable) {
        cn._socketServerChker = setInterval(function () {
            _.forEach(cn.servers, function (server, key) {
                var using = false;

                _.forEach(cn.serverInfo, function (serverInfo) {
                    _.forEach(serverInfo.reporters, function (reporter, path) {
                        if (server._port === reporter.port)
                            using = true;
                    });
                });

                if (using === false && server._port !== cn.port) {
                    server.close();
                    cn.servers[key] = null;
                    delete cn.servers[key];
                }
            });
        }, cn._config.serverChkTime * 1000);  
    }
};

/*********************************************************
 * Private function                                      *
 *********************************************************/
function chackResourceAttrs(val, gt, lt, step, lastRpVal) {
    var chkRp = false;

    if (_.isObject(val)) {
        if (_.isObject(lastRpVal)) {
            _.forEach(lastRpVal, function (v, k) {
                chkRp = chkRp || (v !== lastRpVal[k]);
            });
        } else {
            chkRp = true;
        }
    } else if (!_.isNumber(val)) {
        chkRp = (lastRpVal !== val);
    } else {
        // check Recource notification class attributes
        if (_.isNumber(gt) && _.isNumber(lt) && lt > gt) {
            chkRp = (lastRpVal !== val) && (val > gt) && (val < lt);
        } else if (_.isNumber(gt) && _.isNumber(lt)) {
            chkRp = _.isNumber(gt) && (lastRpVal !== val) && (val > gt);
            chkRp = chkRp || (_.isNumber(lt) && (lastRpVal !== val) && (val < lt));
        } else {
            chkRp = (lastRpVal !== val);
        }

        if (_.isNumber(step)) 
            chkRp = (Math.abs(val - lastRpVal) > step);
    }

    return chkRp;
}

/*********************************************************
 * Module Exports                                        *
 *********************************************************/
module.exports = helper;
