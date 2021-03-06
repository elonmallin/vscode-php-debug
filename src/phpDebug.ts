import * as vscode from 'vscode-debugadapter';
import {DebugProtocol as VSCodeDebugProtocol} from 'vscode-debugprotocol';
import * as net from 'net';
import * as xdebug from './xdebugConnection';
import urlRelative = require('url-relative');
import moment = require('moment');
import * as url from 'url';
import * as path from 'path';
import * as util from 'util';

/** converts a path to a file URI */
function fileUrl(path: string): string {
    let pathName = path.replace(/\\/g, '/');
    // Windows drive letter must be prefixed with a slash
    if (pathName[0] !== '/') {
        pathName = '/' + pathName;
    }
    return encodeURI('file://' + pathName);
}

/** formats a xdebug property value for VS Code */
function formatPropertyValue(property: xdebug.BaseProperty): string {
    let displayValue: string;
    if (property.hasChildren || property.type === 'array' || property.type === 'object') {
        if (property.type === 'array') {
            // for arrays, show the length, like a var_dump would do
            displayValue = 'array(' + (property.hasChildren ? property.numberOfChildren : 0) + ')';
        } else if (property.type === 'object' && property.class) {
            // for objects, show the class name as type (if specified)
            displayValue = property.class;
        } else {
            // edge case: show the type of the property as the value
            displayValue = property.type;
        }
    } else {
        // for null, uninitialized, resource, etc. show the type
        displayValue = property.value || property.type === 'string' ? property.value : property.type;
        if (property.type === 'string') {
            displayValue = '"' + displayValue + '"';
        } else if (property.type === 'bool') {
            displayValue = !!parseInt(displayValue) + '';
        }
    }
    return displayValue;
}

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
interface LaunchRequestArguments extends VSCodeDebugProtocol.LaunchRequestArguments {
    /** The port where the adapter should listen for XDebug connections (default: 9000) */
    port: number;
    /** Automatically stop target after launch. If not specified, target does not stop. */
    stopOnEntry?: boolean;
    /** The source root on the server when doing remote debugging on a different host */
    serverSourceRoot?: string;
    /** The path to the source root on this machine that is the equivalent to the serverSourceRoot on the server. May be relative to cwd. */
    localSourceRoot?: string;
    /** The current working directory, by default the project root */
    cwd?: string;
    /** If true, will log all communication between VS Code and the adapter to the console */
    log: boolean;
}

class PhpDebugSession extends vscode.DebugSession {

    /** The arguments that were given to launchRequest */
    private _args: LaunchRequestArguments;

    /** The TCP server that listens for XDebug connections */
    private _server: net.Server;

    /**
     * A map from VS Code thread IDs to XDebug Connections.
     * XDebug makes a new connection for each request to the webserver, we present hese as threads to VS Code.
     * The threadId key is equal to the id attribute of the connection.
     */
    private _connections = new Map<number, xdebug.Connection>();

    /** A set of connecitons which still need to be initialized with exception breakpoints before _runOrStopOnEntry can be called. */
    private _connectionsAwaitingExceptionBreakpoints = new Set<xdebug.Connection>();

    /** A set of connecitons which still need to be initialized with exception breakpoints before _runOrStopOnEntry can be called. */
    private _connectionsAwaitingBreakpoints = new Set<xdebug.Connection>();

    /** A counter for unique stackframe IDs */
    private _stackFrameIdCounter = 1;

    /** A map from unique stackframe IDs (even across connections) to XDebug stackframes */
    private _stackFrames = new Map<number, xdebug.StackFrame>();

    /** A counter for unique context, property and eval result properties (as these are all requested by a VariableRequest from VS Code) */
    private _variableIdCounter = 1;

    /** A map from unique VS Code variable IDs to an XDebug contexts */
    private _contexts = new Map<number, xdebug.Context>();

    /** A map from unique VS Code variable IDs to a XDebug properties */
    private _properties = new Map<number, xdebug.Property>();

    /** A map from unique VS Code variable IDs to XDebug eval result properties, because property children returned from eval commands are always inlined */
    private _evalResultProperties = new Map<number, xdebug.EvalResultProperty>();

    public constructor(debuggerLinesStartAt1: boolean = true, isServer: boolean = false) {
        super(debuggerLinesStartAt1, isServer);
    }

    protected attachRequest(response: VSCodeDebugProtocol.AttachResponse, args: VSCodeDebugProtocol.AttachRequestArguments) {
        this.sendErrorResponse(response, 0, 'Attach requests are not supported');
        this.shutdown();
    }

    protected launchRequest(response: VSCodeDebugProtocol.LaunchResponse, args: LaunchRequestArguments): void {
        if (args.serverSourceRoot) {
            // use cwd by default for localSourceRoot
            if (!args.localSourceRoot) {
                args.localSourceRoot = '.';
            }
            // resolve localSourceRoot relative to the project root
            args.localSourceRoot = path.resolve(args.cwd, args.localSourceRoot);
        }
        this._args = args;
        const server = this._server = net.createServer();
        server.on('connection', (socket: net.Socket) => {
            // new XDebug connection
            const connection = new xdebug.Connection(socket);
            this._connections.set(connection.id, connection);
            this._connectionsAwaitingBreakpoints.add(connection);
            this._connectionsAwaitingExceptionBreakpoints.add(connection);
            connection.waitForInitPacket()
                .then(() => {
                    this.sendEvent(new vscode.ThreadEvent('started', connection.id));
                })
                // set max_depth to 1 since VS Code requests nested structures individually anyway
                .then(initPacket => connection.sendFeatureSetCommand('max_depth', '1'))
                // raise default of 32
                .then(response => connection.sendFeatureSetCommand('max_children', '9999'))
                // request breakpoints from VS Code
                // once VS Code has set all breakpoints (eg breakpointsSet and exceptionBreakpointsSet are true) _runOrStopOnEntry will be called
                .then(response => this.sendEvent(new vscode.InitializedEvent()))
                .catch(error => {
                    console.error('error: ', error);
                });
        });
        server.listen(args.port);
        this.sendResponse(response);
    }

    /** is called after all breakpoints etc. are initialized and either runs the script or notifies VS Code that we stopped on entry, depending on launch settings */
    private _runOrStopOnEntry(connection: xdebug.Connection): void {
        // either tell VS Code we stopped on entry or run the script
        if (this._args.stopOnEntry) {
            this.sendEvent(new vscode.StoppedEvent('entry', connection.id));
        } else {
            connection.sendRunCommand().then(response => this._checkStatus(response));
        }
    }

    /** Checks the status of a StatusResponse and notifies VS Code accordingly */
    private _checkStatus(response: xdebug.StatusResponse): void {
        const connection = response.connection;
        if (response.status === 'stopping') {
            connection.sendStopCommand().then(response => this._checkStatus(response));
        } else if (response.status === 'stopped') {
            this._connections.delete(connection.id);
            this.sendEvent(new vscode.ThreadEvent('exited', connection.id));
            connection.close();
        } else if (response.status === 'break') {
            // StoppedEvent reason can be 'step', 'breakpoint', 'exception' or 'pause'
            let stoppedEventReason: string;
            let exceptionText: string;
            if (response.exception) {
                stoppedEventReason = 'exception';
                exceptionText = response.exception.name + ': ' + response.exception.message; // this seems to be ignored currently by VS Code
            } else if (response.command.indexOf('step') === 0) {
                stoppedEventReason = 'step';
            } else {
                stoppedEventReason = 'breakpoint';
            }
            this.sendEvent(new vscode.StoppedEvent(stoppedEventReason, connection.id, exceptionText));
        }
    }

    /** converts a server-side XDebug file URI to a local path for VS Code with respect to source root settings */
    protected convertDebuggerPathToClient(fileUri: string): string {
        // convert the file URI to a path
        let serverPath = decodeURI(url.parse(fileUri).pathname);
        // strip the trailing slash from Windows paths (indicated by a drive letter with a colon)
        if (/^\/[a-zA-Z]:\//.test(serverPath)) {
            serverPath = serverPath.substr(1);
        }
        let localPath: string;
        if (this._args.serverSourceRoot && this._args.localSourceRoot) {
            // get the part of the path that is relative to the source root
            const pathRelativeToSourceRoot = path.relative(this._args.serverSourceRoot, serverPath);
            // resolve from the local source root
            localPath = path.resolve(this._args.localSourceRoot, pathRelativeToSourceRoot);
        } else {
            localPath = path.normalize(serverPath);
        }
        return localPath;
    }

    /** converts a local path from VS Code to a server-side XDebug file URI with respect to source root settings */
    protected convertClientPathToDebugger(localPath: string): string {
        let localFileUri = fileUrl(localPath);
        let serverFileUri: string;
        if (this._args.serverSourceRoot && this._args.localSourceRoot) {
            let localSourceRootUrl = fileUrl(this._args.localSourceRoot);
            if (!localSourceRootUrl.endsWith('/')) {
                localSourceRootUrl += '/';
            }
            let serverSourceRootUrl = fileUrl(this._args.serverSourceRoot);
            if (!serverSourceRootUrl.endsWith('/')) {
                serverSourceRootUrl += '/';
            }
            // get the part of the path that is relative to the source root
            const urlRelativeToSourceRoot = urlRelative(localSourceRootUrl, localFileUri);
            // resolve from the server source root
            serverFileUri = url.resolve(serverSourceRootUrl, urlRelativeToSourceRoot);
        } else {
            serverFileUri = localFileUri;
        }
        return serverFileUri;
    }

    /** Logs all requests before dispatching */
    protected dispatchRequest(request: VSCodeDebugProtocol.Request) {
        const log = `-> ${request.command}Request\n${util.inspect(request, {depth: null})}\n\n`;
        console.log(log);
        if (this._args && this._args.log) {
            this.sendEvent(new vscode.OutputEvent(log));
        }
        super.dispatchRequest(request);
    }

    public sendEvent(event: VSCodeDebugProtocol.Event): void {
        const log = `<- ${event.event}Event\n${util.inspect(event, {depth: null})}\n\n`;
        console.log(log);
        if (this._args && this._args.log && !(event instanceof vscode.OutputEvent)) {
            this.sendEvent(new vscode.OutputEvent(log));
        }
        super.sendEvent(event);
	}

    public sendResponse(response: VSCodeDebugProtocol.Response) {
        const log = `<- ${response.command}Response\n${util.inspect(response, {depth: null})}\n\n`;
        console[response.success ? 'log' : 'error'](log);
        if (this._args && this._args.log) {
            this.sendEvent(new vscode.OutputEvent(log, response.success ? 'stdout' : 'stderr'));
        }
        super.sendResponse(response);
    }

    /** This is called for each source file that has breakpoints with all the breakpoints in that file and whenever these change. */
    protected setBreakPointsRequest(response: VSCodeDebugProtocol.SetBreakpointsResponse, args: VSCodeDebugProtocol.SetBreakpointsArguments) {
        const fileUri = this.convertClientPathToDebugger(args.source.path);
        const connections = Array.from(this._connections.values());
        let breakpoints: vscode.Breakpoint[];
        let breakpointsSetPromise: Promise<any>;
        if (connections.length === 0) {
            // if there are no connections yet, we cannot verify any breakpoint
            breakpoints = args.lines.map(line => new vscode.Breakpoint(false, line));
            breakpointsSetPromise = Promise.resolve();
        } else {
            breakpoints = [];
            breakpointsSetPromise = Promise.all(connections.map((connection, connectionIndex) =>
                // clear breakpoints for this file
                connection.sendBreakpointListCommand()
                    .then(response => Promise.all(
                        response.breakpoints
                            .filter(breakpoint => breakpoint.type === 'line' && breakpoint.fileUri === fileUri)
                            .map(breakpoint => breakpoint.remove())
                    ))
                    // set them
                    .then(() => Promise.all(args.lines.map(line =>
                        connection.sendBreakpointSetCommand({type: 'line', fileUri, line})
                            .then(xdebugResponse => {
                                // has this connection finally received its long-awaited breakpoints?
                                if (this._connectionsAwaitingBreakpoints.has(connection)) {
                                    // remember that the breakpoints for this connection have been set
                                    this._connectionsAwaitingBreakpoints.delete(connection);
                                    // if this connection has already received exception breakpoints, run it now
                                    if (!this._connectionsAwaitingExceptionBreakpoints.has(connection)) {
                                        this._runOrStopOnEntry(connection);
                                    }
                                }
                                // only capture each breakpoint once
                                if (connectionIndex === 0) {
                                    breakpoints.push(new vscode.Breakpoint(true, line));
                                }
                            })
                            .catch(error => {
                                // only capture each breakpoint once
                                if (connectionIndex === 0) {
                                    console.error('breakpoint could not be set: ', error);
                                    breakpoints.push(new vscode.Breakpoint(false, line));
                                }
                            })
                    )))
            ));
        }
        breakpointsSetPromise
            .then(() => {
                response.body = {breakpoints};
                this.sendResponse(response);
            })
            .catch(error => {
                this.sendErrorResponse(response, error.code, error.message);
            });
    }

    /** This is called once after all line breakpoints have been set and whenever the breakpoints settings change */
    protected setExceptionBreakPointsRequest(response: VSCodeDebugProtocol.SetExceptionBreakpointsResponse, args: VSCodeDebugProtocol.SetExceptionBreakpointsArguments): void {
        // args.filters can contain 'all' and 'uncaught', but 'uncaught' is the only setting XDebug supports
        const breakOnExceptions = args.filters.indexOf('uncaught') !== -1;
        if (args.filters.indexOf('all') !== -1) {
            this.sendEvent(new vscode.OutputEvent('breaking on caught exceptions is not supported by XDebug', 'stderr'));
        }
        const connections = Array.from(this._connections.values());
        // remove all exception breakpoints
        Promise.all(connections.map(connection =>
            // remove all exception breakpoints
            connection.sendBreakpointListCommand()
                .then(response => Promise.all(
                    response.breakpoints
                        .filter(breakpoint => breakpoint.type === 'exception')
                        .map(breakpoint => breakpoint.remove())
                ))
                .then(() => {
                    // if enabled, set exception breakpoint for all exceptions
                    if (breakOnExceptions) {
                        return connection.sendBreakpointSetCommand({type: 'exception', exception: '*'});
                    }
                })
                .then(() => {
                    // has this connection finally received its long-awaited exception breakpoints?
                    if (this._connectionsAwaitingExceptionBreakpoints.has(connection)) {
                        // remember that the exception breakpoints for this connection have been set
                        this._connectionsAwaitingExceptionBreakpoints.delete(connection);
                        // if this connection has already received line breakpoints, run it now
                        if (!this._connectionsAwaitingBreakpoints.has(connection)) {
                            this._runOrStopOnEntry(connection);
                        }
                    }
                })
        )).then(() => {
            this.sendResponse(response);
        }).catch(error => {
            this.sendErrorResponse(response, error.code, error.message);
        });
    }

    /** Executed after a successfull launch or attach request and after a ThreadEvent */
    protected threadsRequest(response: VSCodeDebugProtocol.ThreadsResponse): void {
        // PHP doesn't have threads, but it may have multiple requests in parallel.
        // Think about a website that makes multiple, parallel AJAX requests to your PHP backend.
        // XDebug opens a new socket connection for each of them, we tell VS Code that these are our threads.
        const connections = Array.from(this._connections.values());
        response.body = {
            threads: connections.map(connection => new vscode.Thread(connection.id, `Request ${connection.id} (${moment(connection.timeEstablished).format('LTS')})`))
        };
        this.sendResponse(response);
    }

    /** Called by VS Code after a StoppedEvent */
    protected stackTraceRequest(response: VSCodeDebugProtocol.StackTraceResponse, args: VSCodeDebugProtocol.StackTraceArguments): void {
        const connection = this._connections.get(args.threadId);
        connection.sendStackGetCommand()
            .then(xdebugResponse => {
                // First delete the old stack trace info ???
                // this._stackFrames.clear();
                // this._properties.clear();
                // this._contexts.clear();
                response.body = {
                    stackFrames: xdebugResponse.stack.map(stackFrame => {
                        // XDebug paths are URIs, VS Code file paths
                        const filePath = this.convertDebuggerPathToClient(stackFrame.fileUri);
                        // "Name" of the source and the actual file path
                        const source = new vscode.Source(path.basename(filePath), filePath);
                        // a new, unique ID for scopeRequests
                        const stackFrameId = this._stackFrameIdCounter++;
                        // save the connection this stackframe belongs to and the level of the stackframe under the stacktrace id
                        this._stackFrames.set(stackFrameId, stackFrame);
                        // prepare response for VS Code (column is always 1 since XDebug doesn't tell us the column)
                        return new vscode.StackFrame(stackFrameId, stackFrame.name, source, stackFrame.line, 1);
                    })
                }
                this.sendResponse(response);
            })
            .catch(error => {
                this.sendErrorResponse(response, error.code, error.message);
            });
    }

    protected scopesRequest(response: VSCodeDebugProtocol.ScopesResponse, args: VSCodeDebugProtocol.ScopesArguments): void {
        const stackFrame = this._stackFrames.get(args.frameId);
        stackFrame.getContexts()
            .then(contexts => {
                response.body = {
                    scopes: contexts.map(context => {
                        const variableId = this._variableIdCounter++;
                        // remember that this new variable ID is assigned to a SCOPE (in XDebug "context"), not a variable (in XDebug "property"),
                        // so when VS Code does a variablesRequest with that ID we do a context_get and not a property_get
                        this._contexts.set(variableId, context);
                        // send VS Code the variable ID as identifier
                        return new vscode.Scope(context.name, variableId);
                    })
                };
                this.sendResponse(response);
            })
            .catch(error => {
                this.sendErrorResponse(response, error.code, error.message);
            });
    }

    protected variablesRequest(response: VSCodeDebugProtocol.VariablesResponse, args: VSCodeDebugProtocol.VariablesArguments): void {
        const variablesReference = args.variablesReference;
        let propertiesPromise: Promise<xdebug.BaseProperty[]>;
        if (this._contexts.has(variablesReference)) {
            // VS Code is requesting the variables for a SCOPE, so we have to do a context_get
            const context = this._contexts.get(variablesReference);
            propertiesPromise = context.getProperties();
        } else if (this._properties.has(variablesReference)) {
            // VS Code is requesting the subelements for a variable, so we have to do a property_get
            const property = this._properties.get(variablesReference);
            propertiesPromise = property.hasChildren ? property.getChildren() : Promise.resolve([]);
        } else if (this._evalResultProperties.has(variablesReference)) {
            // the children of properties returned from an eval command are always inlined, so we simply resolve them
            const property = this._evalResultProperties.get(variablesReference);
            propertiesPromise = Promise.resolve(property.children);
        } else {
            console.error('Unknown variable reference: ' + variablesReference);
            console.error('Known variables: ' + JSON.stringify(Array.from(this._properties)));
            this.sendErrorResponse(response, 0, 'Unknown variable reference');
            return;
        }
        propertiesPromise
            .then(properties => {
                response.body = {
                    variables: properties.map(property => {
                        const displayValue = formatPropertyValue(property);
                        let variablesReference: number;
                        if (property.hasChildren || property.type === 'array' || property.type === 'object') {
                            // if the property has children, we have to send a variableReference back to VS Code
                            // so it can receive the child elements in another request.
                            // for arrays and objects we do it even when it does not have children so the user can still expand/collapse the entry
                            variablesReference = this._variableIdCounter++;
                            if (property instanceof xdebug.Property) {
                                this._properties.set(variablesReference, property);
                            } else if (property instanceof xdebug.EvalResultProperty) {
                                this._evalResultProperties.set(variablesReference, property);
                            }
                        } else {
                            variablesReference = 0;
                        }
                        return new vscode.Variable(property.name, displayValue, variablesReference);
                    })
                }
                this.sendResponse(response);
            })
            .catch(error => {
                console.error(util.inspect(error));
                this.sendErrorResponse(response, error.code, error.message);
            })
    }

    protected continueRequest(response: VSCodeDebugProtocol.ContinueResponse, args: VSCodeDebugProtocol.ContinueArguments): void {
        if (!args.threadId) {
            this.sendErrorResponse(response, 0, 'No active connection');
            return;
        }
        const connection = this._connections.get(args.threadId);
        connection.sendRunCommand()
            .then(response => this._checkStatus(response))
            .catch(error => this.sendErrorResponse(response, error.code, error.message));
        this.sendResponse(response);
    }

    protected nextRequest(response: VSCodeDebugProtocol.NextResponse, args: VSCodeDebugProtocol.NextArguments): void {
        if (!args.threadId) {
            this.sendErrorResponse(response, 0, 'No active connection');
            return;
        }
        const connection = this._connections.get(args.threadId);
        connection.sendStepOverCommand()
            .then(response => this._checkStatus(response))
            .catch(error => this.sendErrorResponse(response, error.code, error.message));
        this.sendResponse(response);
    }

	protected stepInRequest(response: VSCodeDebugProtocol.StepInResponse, args: VSCodeDebugProtocol.StepInArguments) : void {
        if (!args.threadId) {
            this.sendErrorResponse(response, 0, 'No active connection');
            return;
        }
        const connection = this._connections.get(args.threadId);
        connection.sendStepIntoCommand()
            .then(response => this._checkStatus(response))
            .catch(error => this.sendErrorResponse(response, error.code, error.message));
		this.sendResponse(response);
	}

	protected stepOutRequest(response: VSCodeDebugProtocol.StepOutResponse, args: VSCodeDebugProtocol.StepOutArguments) : void {
        if (!args.threadId) {
            this.sendErrorResponse(response, 0, 'No active connection');
            return;
        }
        const connection = this._connections.get(args.threadId);
        connection.sendStepOutCommand()
            .then(response => this._checkStatus(response))
            .catch(error => this.sendErrorResponse(response, error.code, error.message));
		this.sendResponse(response);
	}

	protected pauseRequest(response: VSCodeDebugProtocol.PauseResponse, args: VSCodeDebugProtocol.PauseArguments) : void {
		this.sendErrorResponse(response, 0, 'Pausing the execution is not supported by XDebug');
	}

    protected disconnectRequest(response: VSCodeDebugProtocol.DisconnectResponse, args: VSCodeDebugProtocol.DisconnectArguments): void {
        Promise.all(Array.from(this._connections).map(([id, connection]) =>
            connection.sendStopCommand()
                .then(response => connection.close())
                .then(() => {
                    this._connections.delete(id);
                })
                .catch(() => {})
        )).then(() => {
            this._server.close(() => {
                this.shutdown();
                this.sendResponse(response);
            })
        }).catch(error => {
            this.sendErrorResponse(response, error.code, error.message)
        });
	}

    protected evaluateRequest(response: VSCodeDebugProtocol.EvaluateResponse, args: VSCodeDebugProtocol.EvaluateArguments): void {
        const connection = this._stackFrames.get(args.frameId).connection;
        connection.sendEvalCommand(args.expression)
            .then(xdebugResponse => {
                if (xdebugResponse.result) {
                    const displayValue = formatPropertyValue(xdebugResponse.result);
                    let variablesReference: number;
                    // if the property has children, generate a variable ID and save the property (including children) so VS Code can request them
                    if (xdebugResponse.result.hasChildren || xdebugResponse.result.type === 'array' || xdebugResponse.result.type === 'object') {
                        variablesReference = this._variableIdCounter++;
                        this._evalResultProperties.set(variablesReference, xdebugResponse.result);
                    } else {
                        variablesReference = 0;
                    }
                    response.body = {result: displayValue, variablesReference};
                } else {
                    response.body = {result: 'no result', variablesReference: 0};
                }
                this.sendResponse(response);
            })
            .catch(error => {
                this.sendErrorResponse(response, error.code, error.message)
            });
    }
}

vscode.DebugSession.run(PhpDebugSession);
