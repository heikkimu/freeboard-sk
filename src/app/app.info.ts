/** Application Information Service **
 * perform version checking etc. here
 * ************************************/
import { Injectable } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { AlertDialog, ConfirmDialog, WelcomeDialog, MessageBarComponent } from './lib/app-ui';

import { Info } from './lib/app-info';
import { Subject, Observable } from 'rxjs';
import { IndexedDB } from './lib/info/indexeddb';
import { SignalKClient } from 'signalk-client-angular';
import { SKVessel } from './modules/skresources/resource-classes';

// ** Configuration template** 
const FreeboardConfig= {      
    experiments: false,
    version: '',
    darkMode: { enabled: false,  source: 0 },  // source: 0= browser default, 1= Signal K mode, -1=manual)
    map: {          // ** map config
        zoomLevel: 2,
        center: [0, 0],
        rotation: 0,
        mrid: null,
        srid: 'EPSG:4326',
        moveMap: false,
        northUp: true,
        animate: false
    },
    vesselTrail: false,     // display trail
    vesselWindVectors: true,// display vessel TWD, AWD vectors
    aisTargets: true,       // display ais targets
    courseData: true,       // display course data
    notes: true,            // display notes
    popoverMulti: false,    // close popovers using cose button
    mapDoubleClick: false,  // true=zoom
    depthAlarm: { enabled: false, smoothing: 10000 },
    anchorRadius: 40,       // most recent anchor radius setting
    plugins: {
        instruments: '/@signalk/instrumentpanel',
        startOnOpen: false,
        parameters: null
    },
    units: {        // ** display units
        distance: 'm',
        depth: 'm',
        speed: 'kn'
    },
    selections: {   // ** saved selections 
        routes: [],
        waypoints: [],
        tracks: [],
        charts: ['openstreetmap','openseamap'],
        notes: [],
        chartOrder: [],  // chart layer ordering
        headingAttribute: 'navigation.headingTrue',
        preferredPaths: {
            tws: 'environment.wind.speedTrue',
            twd: 'environment.wind.directionTrue',
            heading: 'navigation.courseOverGroundTrue',
            course: 'navigation.courseGreatCircle'
        },
        positionFormat: 'XY',
        aisTargets: null,
        aisWindApparent: false,
        aisWindMinZoom: 15,
        aisShowTrack: false,
        aisMaxAge: 540000,         // time since last update in ms (9 min)
        aisStaleAge: 360000,       // time since last update in ms (6 min)
        aisProfile: 0,             // ais display profile
        notesMinZoom: 10,
        pluginFavourites: [],
        trailFromServer: false,
        trailDuration: 24,   // number of hours of trail to fetch from server,
        resourceSets: {},    // additional resources
        signalk: {              // signal k connection options
            vessels: true,
            atons: true,
            aircraft: false,
            sar: false,
            maxRadius: 0,        // max radius within which AIS targets are displayed
        }
    },
    resources: {    // ** resource options
        notes: {
            rootFilter: '?position=%map:latitude%,%map:longitude%&dist=%note:radius%',     // param string to provide record filtering
            getRadius: 20,      // radius (NM/km) within which to return notes
            groupNameEdit: false,
            groupRequiresPosition: false
        },
        video: {
            enable: false, 
            url: null
        },
        paths: []
    }
} 

@Injectable({ providedIn: 'root' })
export class AppInfo extends Info {

    private DEV_SERVER= {
        host: '172.17.0.1',  //'192.168.86.32', //'172.17.0.1', // host name || ip address
        port: 3000,     // port number
        ssl: false
    };

    public hostName: string;
    public hostPort: number;
    public hostSSL: boolean;
    public host= '';

    public db: AppDB;

    get useMagnetic(): boolean { 
        return  (this.config.selections.headingAttribute=='navigation.headingMagnetic') ? true : false;
    }

    constructor( public signalk: SignalKClient,
                private dialog: MatDialog,
                private snackbar: MatSnackBar) {
        super();

        this.db= new AppDB();

        this.hostName= (this.devMode && this.DEV_SERVER.host) ? this.DEV_SERVER.host : window.location.hostname;
        this.hostPort= (this.devMode && this.DEV_SERVER.port) ? this.DEV_SERVER.port : parseInt(window.location.port);
        this.hostSSL= (window.location.protocol=='https:' || 
                        (this.devMode && this.DEV_SERVER.ssl) ) ? true : false;

        this.host= (this.devMode) ? 
            `${this.hostSSL ? 'https:' : 'http:'}//${this.hostName}:${this.hostPort}` :
            `${window.location.protocol}//${window.location.host}`;

        this.id='freeboard';
        this.name= "Freeboard";
        this.shortName= "freeboard";
        this.description= `Signal K Chart Plotter.`;
        this.version= '1.16.3';
        this.url= 'https://github.com/signalk/freeboard-sk';
        this.logo= "./assets/img/app_logo.png";   
        
        this.signalk.setAppId(this.id);     // server stored data appId
        this.signalk.setAppVersion('1.0.0');  // server stored data version
        
        // base config
        this.config= JSON.parse(JSON.stringify(FreeboardConfig));
        // ** received data
        this.data= {
            loggedIn: false,
            grib: {
                hasProvider: false,
                values: { wind: null, temperature: null}
            },
            routes: [],
            waypoints: [],
            charts: [],
            alarms: new Map(),
            notes: [],
            resourceSets: {},   // additional resource sets
            selfId: null,
            activeRoute: null,
            activeWaypoint: null,
            trail: [],          // self vessel track / trail
            serverTrail: false,  // trail received from server
            server: null,
            hasToken: false,
            lastGet: null,      // map position of last resources GET
            vessels: {          // received vessel data
                showSelf: false,
                self: new SKVessel(), 
                aisTargets: new Map(),
                aisTracks: new Map(),   // AIS targets track (tracks plugin)
                activeId: null,
                active: null,
                closest: {id: null, distance: null, timeTo: null, position: [0,0]},
                prefAvailablePaths: {}  // preference paths available from source
            },
            aircraft: new Map(),    // received AIS aircraft data
            atons: new Map(),       // received AIS AtoN data
            sar: new Map(),         // received AIS SaR data
            aisMgr: {               // manage aisTargets
                updateList: [],
                staleList: [],
                removeList: []
            },
            navData: {
                vmg: null,
                dtg: null,
                ttg: null,
                bearing: {value: null, type: null},
                bearingTrue: null,
                bearingMagnetic: null,
                xte: null,
                position: null,
                pointIndex: -1,
                pointTotal: 0,
                arrivalCircle: null,
                startPosition: null,
                pointNames: []
            },
            anchor: {       // ** anchor watch
                raised: true,
                radius: 0,
                position: [0,0]
            }
        }

        /***************************************
         * Subscribe to App events as required
         ***************************************/
        // ** version update **   
        this.upgraded$.subscribe( version=> {
            this.handleUpgradeEvent(version)
        });
        // ** settings load / save events
        this.settings$.subscribe( value=> {
            this.handleSettingsEvent(value);
        });    
        // ** database events
        this.db.dbUpdate$.subscribe( res=> {
            if(res.action) {
                switch(res.action) {
                    case 'db_init':
                        if(res.value) { 
                            if(this.config.vesselTrail) {
                                this.db.getTrail().then( t=> { 
                                    this.data.trail= (t && t.value) ? t.value : [];
                                });
                            }
                        }
                        break;
                    case 'trail_save':
                        if(!res.value) { this.debug('app.trail.save.error', 'warn') }
                        break;                        
                }
            }
        }); 
        
        this.init();  
        // ** detect if launched in iframe **
        try {this.data.optAppPanel= (window.self== window.top) }
        catch(e) { this.data.optAppPanel=false }

        /***************************************
         * trigger app version check
         * uses: handleUpgradeEvent() subscription
         ***************************************/
        let v= this.checkVersion();
        if(!v.result) { //** current version
            this.loadConfig();
            this.loadData();            
        }

        // ** check for internet connection **
        window.fetch('https://tiles.openseamap.org/seamark/')
        .then( (r:any)=> {
            console.info('Internet connection detected.');
        })
        .catch((e:any)=> {
            console.warn('No Internet connection detected!');
            let mapsel= this.config.selections.charts;
            if(mapsel.includes('openstreetmap') || mapsel.includes('openseamap') ) {
                this.showAlert(
                    'Internet Map Service Unavailable: ', 
                    `Unable to display Open Street / Sea Maps!\n
                    Please check your Internet connection or select maps from the local network.\n
                    `
                );
            }
        })
    }

    // persist auth token for session
    persistToken(value:string) {
        if(value) {
            this.signalk.authToken= value;
            document.cookie = `sktoken=${value}; SameSite=Strict`;
            this.data.hasToken= true; // hide login menu item
        }
        else {
            this.data.hasToken= false; // show login menu item
            this.signalk.authToken= null;
        }
    }
    
    // return auth token for session
    getToken(): string {
        let tk= new Map();
        let ca= document.cookie.split(';').map( i=> { 
            let c= i.split('='); 
            tk.set(c[0],c[1]);
        });
        if(tk.has('sktoken')) { return tk.get('sktoken') }
        else { return null }
    }

    // ** handle App version upgrade **
    handleUpgradeEvent(version) { 
        this.debug('App Upgrade Handler...Start...', 'info');
        this.debug(version);
        // *******************
		
        if( version.result && version.result=='update' ) {
            this.debug('Upgrade result....new version detected');
            this.loadConfig();
            this.loadData();
            // transform config / data as required here    
            this.data['updatedRun']= version;
            // apply to this.config / this.data
        }
        else if( version.result && version.result=='new' ) {
            this.debug('Upgrade result....new installation');
            this.loadConfig();
            this.loadData();
            this.data['firstRun']=true;
        }        
        
        // *******************
        this.saveInfo();
        this.debug('App Upgrade Handler...End...', 'info');
    } 

    // ** handle Settings load / save **
    handleSettingsEvent(value) {
        this.debug(value);
        if(value.action=='load' && value.setting=='config') {
            this.cleanConfig(this.config);
        }
    }

    // ** get user settings from server **
    loadSettingsfromServer(): Observable<boolean> {
        let sub: Subject<boolean>= new Subject();
        this.signalk.isLoggedIn().subscribe( 
            r=> {
                this.data.loggedIn= r;
                if(r) { // ** get server stored config for logged in user **
                    this.signalk.appDataGet('/').subscribe(
                        (settings:any)=> {
                            if(Object.keys(settings).length==0) { return }
                            this.cleanConfig(settings);
                            if(this.validateConfig(settings)) { 
                                this.config= settings;
                                this.saveConfig();
                                sub.next(true);
                            }
                        },
                        ()=> {
                            console.info('applicationData: Unable to retrieve settings from server!');
                            sub.next(false);
                        }
                    );   
                }                     
            },
            ()=> { 
                this.data.loggedIn=false;
                console.info('Unable to get loginStatus!');
                sub.next(false);
            }
        );
        return sub.asObservable();
    }    

    // ** overloaded saveConfig() **
    saveConfig() {
        super.saveConfig();
        if(this.data.loggedIn) {
            this.signalk.appDataSet('/', this.config).subscribe(
                ()=> this.debug('saveConfig: config saved to server.'),
                ()=> this.debug('saveConfig: Cannot save config to server!')
            );                
        }
    }

    // ** clean loaded config /settings keys **
    cleanConfig(settings:any) {
        this.debug('Cleaning config keys...');
        if(typeof settings.usePUT !== 'undefined') { delete settings.usePUT }
        if(typeof settings.anchor !== 'undefined') { delete settings.anchor}

        if(typeof settings.anchorRadius === 'undefined') { 
            settings.anchorRadius= 40;
        }
        
        if(typeof settings.vesselWindVectors === 'undefined') {
            settings.vesselWindVectors= true;
        }  

        if(typeof settings.aisShowTrack === 'undefined') {
            settings.aisShowTrack= false;
        }

        if(typeof settings.selections === 'undefined') { settings.selections={} } 
        if(typeof settings.selections.aisWindMinZoom === 'undefined') {
            settings.selections.aisWindMinZoom= 15;
        }
        if(typeof settings.selections.aisWindApparent === 'undefined') {
            settings.selections.aisWindApparent= false;
        }
        if(typeof settings.selections.notesMinZoom === 'undefined') {
            settings.selections.notesMinZoom= 10;
        } 
        if(typeof settings.selections.preferredPaths === 'undefined') {
            settings.selections.preferredPaths= {
                tws: 'environment.wind.speedTrue',
                twd: 'environment.wind.directionTrue',
                heading: 'navigation.courseOverGroundTrue',
                course: 'navigation.courseGreatCircle'
            }
        }  
        if(typeof settings.selections.preferredPaths.course === 'undefined') {
            settings.selections.preferredPaths.course= 'navigation.courseGreatCircle';
        }
        if(typeof settings.selections.pluginFavourites === 'undefined') {
            settings.selections['pluginFavourites']= [];
        } 
        if(typeof settings.selections.positionFormat === 'undefined') {
            settings.selections['positionFormat']= 'XY';
        }
        if(typeof settings.selections.chartOrder === 'undefined') {
            settings.selections['chartOrder']= [];
        } 
        if(typeof settings.selections.tracks === 'undefined') {
            settings.selections.tracks= [];
        } 
        if(typeof settings.selections.trailDuration === 'undefined') {
            settings.selections.trailDuration= 24;
        } 
        if(typeof settings.selections.resourceSets === 'undefined') {
            settings.selections.resourceSets= {};
        } 
        if(typeof settings.selections.aisMaxAge === 'undefined') {
            settings.selections.aisMaxAge= 540000;
        } 
        if(typeof settings.selections.aisStaleAge === 'undefined') {
            settings.selections.aisStaleAge= 360000;
        }
        if(typeof settings.selections.aisProfile === 'undefined') {
            settings.selections.aisProfile= 0;
        }
        if(typeof settings.selections.signalk === 'undefined') {
            settings.selections.signalk= {
                vessels: true,
                atons: true,
                aircraft: false,
                sar: false,
                maxRadius: 0
            }
        }
        
        if(typeof settings.plugins === 'undefined') { settings.plugins= {} }
        if(typeof settings.plugins.parameters === 'undefined') { 
            settings.plugins.parameters= null;
        }  
        
        if(typeof settings.resources === 'undefined') {
            settings.resources= { 
                notes: {
                    rootFilter: '?position=%map:latitude%,%map:longitude%&dist=%note:radius%',     
                    getRadius: 20,     
                    groupNameEdit: false,
                    groupRequiresPosition: false
                }
            }
        }  
        else {
            if(typeof settings.resources.video === 'undefined') { 
                settings.resources.video= { enable: false, url: null};
            }
            if(typeof settings.resources.paths === 'undefined') { 
                settings.resources.paths= [];
            } 
        }
    }

    // ** validate settings against base config **
    validateConfig(settings:any):boolean {
        let result:boolean= true;
        let skeys= Object.keys(settings);
        Object.keys(FreeboardConfig).forEach( i=> {
            if(!skeys.includes(i)) { result=false }
        });
        return result;
    }

    // ** show Help at specified anchor
    showHelp(anchor?:string) {
        let url= `./assets/help/index.html${(anchor) ? '#' + anchor : ''}`
        window.open(url, 'help');
    }

    // ** display Welcome dialog
    showWelcome() {
        const WelcomeMessages= {
            'welcome': {
                title: 'Welcome to Freeboard',
                message: `Freeboard is your Signal K chartplotter WebApp from which
                    you can manage routes, waypoints, notes, alarms, 
                    notifications and more.`
            },
            'signalk-server-node': {
                title: 'Node Server',
                message: `When using the Node version of Signal K server you will need to
                    ensure plugins are installed that can service the 
                    required Signal K API paths:<br>
                    e.g. <i>resources/routes, resources/waypoints, etc</i>.

                    See <a href="assets/help/index.html" target="help">HELP</a> 
                    for more details.`
            },
            'preferred-paths': {
                title: 'Set Paths',
                message: `Freeboard allows you select a preferred Signal K path for 
                    displaying:
                    <ul>
                    <li>Vessel heading</li>
                    <li>True Wind Speed / Direction</li>
                    </ul>
                    from the available paths received from the server. 
                    See <a href="assets/help/index.html#settings-paths" target="help">HELP</a> 
                    for more details.`
            },                
            'experiments': {
                title: 'Experiments',
                message: `
                    Experiments are a means for testing out potential new features
                    in Freeboard.
                    <br>&nbsp;<br>
                    You can enable Experiments in <b><i>Settings</i></b>.
                    <br>&nbsp;<br>
                    Check out <a href="assets/help/index.html#experiments" target="help">HELP</a> 
                    for more details.`
            },
            'whats-new': [
                {
                    type: 'signalk-server-node',
                    title: 'Deprecation Notice',
                    message: `
                        Not all experiments are destined to reach the main product 
                        and the GRIB experiment will be removed in the next release.
                        <br>&nbsp;<br>
                        GRIB wind and temperature overlays required GRIB2JSON formatted data hosted
                        on the Signal K server by the freeboard-sk-helper plugin. This is better suited 
                        to a tile data source akin to charts.
                    `
                }                
            ]           
        }

        let btnText:string= 'Get Started'
        let messages: Array<any>= []
        let showPrefs: boolean= false;

        if( this.data.firstRun || this.data.updatedRun) {
            if(this.data.firstRun) { 
                messages.push( WelcomeMessages['welcome'] ); 
                if(this.data.server && this.data.server.id) {
                    messages.push( WelcomeMessages[ this.data.server.id] ); 
                    showPrefs= true;
                }
                messages.push( WelcomeMessages['preferred-paths'] ); 
            }
            else {
                let ver= this.data.updatedRun.previous.split('.');
                if(ver[0]==1 && ver[1]<7) {
                    messages.push( WelcomeMessages['preferred-paths'] );
                    showPrefs= true;
                }
                if(WelcomeMessages['whats-new'] && WelcomeMessages['whats-new'].length>0) {
                    WelcomeMessages['whats-new'].forEach( msg=> {
                        if(msg.type) {
                            if( (this.data.server && this.data.server.id) 
                                && msg.type==this.data.server.id) { messages.push(msg) }
                        }
                        else { messages.push( msg);}
                    })
                }
                btnText= 'Got it'
            } 

            if(messages.length==0) { return }
            return this.dialog.open(WelcomeDialog, {
                disableClose: true,
                data: { 
                    buttonText: btnText,
                    content: messages,
                    showPrefs: showPrefs
                }
            });   
        }     
    } 

    // ** display alert dialog
    showAlert(title:string, message:string, btn?:string) {
        return this.dialog.open(AlertDialog, {
            disableClose: false,
            data: { 
                message: message, 
                title: title,
                buttonText: btn 
            }
        }).afterClosed();        
    } 

    // ** display message bar
    showMessage(message:string, sound:boolean=false, duration:number=5000) {
        this.snackbar.openFromComponent( MessageBarComponent, 
            { 
                duration: duration,
                data: { message: message, sound: sound }
            }
        );        
    } 
    
    // ** display confirm dialog **
    showConfirm(message:string, title:string, btn1?:string, btn2?:string) {
        return this.dialog.open(ConfirmDialog, {
            disableClose: true,
            data: { 
                message: message, 
                title: title,
                button1Text: btn1,
                button2Text: btn2
            }
        }).afterClosed();
    }

}

/******************
** App Database  **
******************/
export class AppDB {

    private db: IndexedDB; 
    private dbUpdateSource;
    public dbUpdate$;

	constructor() {
		this.dbUpdateSource= new Subject<string>();
        this.dbUpdate$ = this.dbUpdateSource.asObservable();
		this.db= new IndexedDB('freeboard', 1);

        this.db.openDatabase(1, (evt) => {
            let trail = evt.currentTarget.result.createObjectStore('trail', {keyPath: 'uuid'});
            trail.createIndex('uuid_idx', 'uuid', {unique: true});
        }).then( 
            ()=> { this.emitDbUpdate({action: 'db_init', value: true}) },
            e=> { this.emitDbUpdate({action: 'db_init', value: false}) }
        );
	}

	// ** emit dbUpdate message **
    emitDbUpdate(value: any= null) { this.dbUpdateSource.next(value) }

	// ** get veesel trail **
	getTrail(id='self') { return this.db.getByIndex('trail', 'uuid_idx', id) }

	// ** create / update vessel trail entry**
	saveTrail(id='self', trailData) {
        this.db.update( 'trail', {uuid: id, value: trailData}).then(
            () => { this.emitDbUpdate({action: 'trail_save', value: true}) }, 
            (e)=> { 
                this.db.add( 'trail', {uuid: id, value: trailData}).then( 
                    () => { this.emitDbUpdate({action: 'trail_save', value: true}) }, 
                    e=> { this.emitDbUpdate({action: 'trail_save', value: false}) }
                );
            }
        );
    }
   
}
